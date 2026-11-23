from collections import defaultdict
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from psycopg.types.json import Jsonb

from core import db, enqueue, require
from model_choice import METHODS, ROUTE_LABELS, compare
from reel_seed import seed_reels

router = APIRouter(prefix="/api/tapes")

PASS_ACCURACY = 0.6

class Measurement(BaseModel):
    start_second: int = Field(ge=0,le=86400)
    dropout: int = Field(ge=0,le=30)
    snaps: int = Field(ge=0,le=20)
    residue: int = Field(ge=0,le=9)

class Correction(BaseModel):
    dropout: int = Field(ge=0,le=30)
    snaps: int = Field(ge=0,le=20)
    residue: int = Field(ge=0,le=9)
    known_route: Literal["clean","mend","rehouse"]

class Assignment(BaseModel):
    excerpt: str = Field(min_length=1,max_length=50)
    fold: int = Field(ge=1,le=3)

class Manifest(BaseModel):
    label: str = Field(min_length=1,max_length=60)
    assignments: list[Assignment] = Field(min_length=6,max_length=60)

class Card(BaseModel):
    excerpt: str = Field(min_length=1,max_length=50)

def rows_for(cx,evaluation):
    """送审时快照的病征与签认工序，排队复验与开卡依据均以此为准。"""
    return cx.execute("""
        SELECT holdout_assignments.excerpt AS code,signal_excerpts.reel,acetate_reels.donation,
               holdout_assignments.fold,holdout_assignments.dropout,holdout_assignments.snaps,
               holdout_assignments.residue,holdout_assignments.known_route
        FROM holdout_assignments JOIN signal_excerpts ON signal_excerpts.code=holdout_assignments.excerpt
        JOIN acetate_reels ON acetate_reels.code=signal_excerpts.reel
        WHERE holdout_assignments.evaluation=%s ORDER BY holdout_assignments.excerpt
    """,(evaluation,)).fetchall()

def effective_manifest(cx):
    return cx.execute("""
        SELECT * FROM evaluation_manifests WHERE activated_at IS NOT NULL
        ORDER BY id DESC LIMIT 1
    """).fetchone()

def validate(rows):
    by_donor = defaultdict(set)
    by_fold = defaultdict(set)
    all_routes = set(ROUTE_LABELS)
    for row in rows:
        by_donor[row["donation"]].add(row["fold"])
        by_fold[row["fold"]].add(row["known_route"])
    leaked = [donation for donation, folds in by_donor.items() if len(folds)>1]
    if leaked:
        raise HTTPException(409, f"同一捐赠批跨折泄漏：{', '.join(sorted(leaked))}")
    if len(by_fold) < 2 or any(routes != all_routes for routes in by_fold.values()):
        raise HTTPException(409,"至少两折，每折必须包含三个工序的签认样段")

@router.get("/catalog")
def catalog(user=Depends(require())):
    with db() as cx:
        reels = cx.execute("SELECT * FROM acetate_reels ORDER BY calibration,code").fetchall()
        readings = cx.execute("""
            SELECT signal_excerpts.*,acetate_reels.donation FROM signal_excerpts
            JOIN acetate_reels ON acetate_reels.code=reel ORDER BY reel,start_second
        """).fetchall()
        manifests = cx.execute("""
            SELECT evaluation_manifests.*,app_jobs.status AS job_status,app_jobs.error AS job_error
            FROM evaluation_manifests LEFT JOIN app_jobs ON app_jobs.id=evaluation_manifests.job
            ORDER BY evaluation_manifests.id DESC LIMIT 30
        """).fetchall()
        cards = cx.execute("""
            SELECT conservation_cards.*,evaluation_manifests.label AS evaluation_label
            FROM conservation_cards JOIN evaluation_manifests ON evaluation_manifests.id=evaluation
            ORDER BY conservation_cards.id DESC
        """).fetchall()
        effective = effective_manifest(cx)
    return {"reels":reels,"readings":readings,"manifests":manifests,"cards":cards,"effective":effective}

@router.post("/reels/{code}/excerpt",status_code=201)
def log_excerpt(code: str, data: Measurement,user=Depends(require("operator"))):
    with db() as cx:
        reel = cx.execute("SELECT * FROM acetate_reels WHERE code=%s",(code,)).fetchone()
        if not reel:
            raise HTTPException(404,"音带卷不存在")
        if reel["calibration"]:
            raise HTTPException(409,"已封存的训练盘不接收新的未签认样段")
        sample = f"{code.replace('-','')}-{data.start_second}"
        cx.execute(
            "INSERT INTO signal_excerpts VALUES (%s,%s,%s,%s,%s,%s,NULL)",
            (sample,code,data.start_second,data.dropout,data.snaps,data.residue),
        )
    return {"code":sample}

@router.post("/excerpts/{code}/correct")
def correct(code: str, data: Correction,user=Depends(require("reviewer"))):
    """补正参考样段的病征与签认工序，仅影响之后封存的复验清单。"""
    with db() as cx:
        row = cx.execute("""
            UPDATE signal_excerpts SET dropout=%s,snaps=%s,residue=%s,known_route=%s
            FROM acetate_reels
            WHERE signal_excerpts.reel=acetate_reels.code AND signal_excerpts.code=%s
              AND acetate_reels.calibration
            RETURNING signal_excerpts.*
        """,(data.dropout,data.snaps,data.residue,data.known_route,code)).fetchone()
        if not row:
            raise HTTPException(409,"仅参考库样段可在工作台补正")
    return row

@router.post("/manifests",status_code=202)
def submit_manifest(data: Manifest,user=Depends(require("reviewer"))):
    codes = [item.excerpt for item in data.assignments]
    if len(set(codes)) != len(codes):
        raise HTTPException(409,"复验清单中有重复样段")
    with db() as cx:
        catalog_rows = cx.execute("""
            SELECT signal_excerpts.*,acetate_reels.donation
            FROM signal_excerpts JOIN acetate_reels ON acetate_reels.code=reel
            WHERE signal_excerpts.code=ANY(%s) AND known_route IS NOT NULL AND calibration
        """,(codes,)).fetchall()
        if len(codes) != len(catalog_rows):
            raise HTTPException(409,"清单中有未签认或不属于参考库的样段")
        assignment = {item.excerpt:item.fold for item in data.assignments}
        validate([row | {"fold":assignment[row["code"]]} for row in catalog_rows])
        version = cx.execute("INSERT INTO evaluation_manifests(label) VALUES (%s) RETURNING id",(data.label,)).fetchone()["id"]
        snapshot = {row["code"]:row for row in catalog_rows}
        for item in data.assignments:
            row = snapshot[item.excerpt]
            cx.execute(
                "INSERT INTO holdout_assignments VALUES (%s,%s,%s,%s,%s,%s,%s)",
                (version,item.excerpt,item.fold,row["dropout"],row["snaps"],row["residue"],row["known_route"]),
            )
        job = enqueue(cx,"reel-validation",{"id":version})
        cx.execute("UPDATE evaluation_manifests SET job=%s WHERE id=%s",(job,version))
    return {"id":version,"job_id":job}

@router.post("/manifests/{version}/retry",status_code=202)
def retry_manifest(version: int,user=Depends(require("reviewer"))):
    """复验失败后按同一版送审快照重试。"""
    with db() as cx:
        manifest = cx.execute(
            "SELECT * FROM evaluation_manifests WHERE id=%s FOR UPDATE",(version,)
        ).fetchone()
        if not manifest:
            raise HTTPException(404,"复验清单不存在")
        if manifest["activated_at"]:
            raise HTTPException(409,"该版已启用，无需重试")
        if manifest["report"] is not None:
            raise HTTPException(409,"该版已有复验报告，如需变更请补正样段后封存新版")
        job = cx.execute("SELECT status FROM app_jobs WHERE id=%s",(manifest["job"],)).fetchone()
        if job and job["status"] in ("queued","running"):
            raise HTTPException(409,"该版复验正在排队或运行")
        retry = enqueue(cx,"reel-validation",{"id":version})
        cx.execute("UPDATE evaluation_manifests SET job=%s WHERE id=%s",(retry,version))
    return {"id":version,"job_id":retry}

def run_job(cx,kind,payload):
    if kind != "reel-validation":
        raise ValueError(kind)
    version = payload["id"]
    rows = rows_for(cx,version)
    validate(rows)
    report = compare(rows)
    cx.execute("UPDATE evaluation_manifests SET report=%s WHERE id=%s",(Jsonb(report),version))
    if report["accuracy"][report["selected"]] >= PASS_ACCURACY:
        activated = cx.execute("""
            UPDATE evaluation_manifests SET activated_at=now()
            WHERE id=%s AND activated_at IS NULL
              AND NOT EXISTS (
                  SELECT 1 FROM evaluation_manifests WHERE activated_at IS NOT NULL AND id>%s
              )
            RETURNING id
        """,(version,version)).fetchone()
        if activated:
            cx.execute("""
                UPDATE conservation_cards SET stage='returned',
                    returned_reason='复验第 ' || %s::text || ' 版已启用，原依据第 '
                        || evaluation::text || ' 版失效，请按生效版重算建议'
                WHERE stage='proposed' AND evaluation<>%s
            """,(version,version))
    return report

@router.post("/cards",status_code=201)
def propose(data: Card,user=Depends(require("operator"))):
    with db() as cx:
        evidence = cx.execute("""
            SELECT signal_excerpts.* FROM signal_excerpts JOIN acetate_reels ON acetate_reels.code=reel
            WHERE signal_excerpts.code=%s AND NOT calibration
        """,(data.excerpt,)).fetchone()
        model = effective_manifest(cx)
        if not evidence or not model:
            raise HTTPException(409,"需待处理样段与已启用的分折复验")
        route, explanation = METHODS[model["report"]["selected"]](evidence,rows_for(cx,model["id"]))
        existing = cx.execute(
            "SELECT * FROM conservation_cards WHERE excerpt=%s FOR UPDATE",(data.excerpt,)
        ).fetchone()
        if existing and existing["stage"] != "returned":
            raise HTTPException(409,"该样段已有工序卡")
        if existing:
            return cx.execute("""
                UPDATE conservation_cards SET evaluation=%s,route=%s,explanation=%s,
                    stage='proposed',returned_reason=NULL,authoriser=NULL
                WHERE id=%s RETURNING *
            """,(model["id"],route,explanation,existing["id"])).fetchone()
        return cx.execute("""
            INSERT INTO conservation_cards(excerpt,evaluation,route,explanation)
            VALUES (%s,%s,%s,%s) RETURNING *
        """,(data.excerpt,model["id"],route,explanation)).fetchone()

@router.post("/cards/{card}/authorise")
def authorise(card: int,user=Depends(require("reviewer"))):
    with db() as cx:
        row = cx.execute("""
            UPDATE conservation_cards SET stage='authorised',authoriser=%s
            WHERE id=%s AND stage='proposed'
              AND evaluation=(SELECT max(id) FROM evaluation_manifests WHERE activated_at IS NOT NULL)
            RETURNING *
        """,(user["email"],card)).fetchone()
        if not row:
            raise HTTPException(409,"仅依据当前生效版的待审工序卡可签发")
    return row

def seed(cx):
    seed_reels(cx)
    record = cx.execute("""
        INSERT INTO evaluation_manifests(label) VALUES ('分藏批复验 · 对照样组')
        ON CONFLICT DO NOTHING RETURNING id
    """).fetchone()
    if record:
        version = record["id"]
        cx.execute("""
            INSERT INTO holdout_assignments(evaluation,excerpt,fold,dropout,snaps,residue,known_route)
            SELECT %s,signal_excerpts.code,RIGHT(donation,1)::smallint,
                   signal_excerpts.dropout,signal_excerpts.snaps,signal_excerpts.residue,signal_excerpts.known_route
            FROM signal_excerpts JOIN acetate_reels ON acetate_reels.code=reel WHERE calibration
        """,(version,))
        run_job(cx,"reel-validation",{"id":version})
