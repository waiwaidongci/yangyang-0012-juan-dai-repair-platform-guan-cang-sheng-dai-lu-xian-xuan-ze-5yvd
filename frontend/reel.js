import {render as rights} from "/extensions/rights/page.js"
import {render as preservation} from "/extensions/preservation/page.js"
import {render as delivery} from "/extensions/delivery/page.js"
import {api, badge, empty, h, mount, notice, waitJob} from '/base.js'

const root = '/api/tapes'
const pages = {reels:'馆藏卷台', readings:'样段观测', lab:'分藏批复验', cards:'工序卡', rights:'授权与使用',preservation:'数字保存质检',delivery:'馆际交付'}
const routeLabels = {clean:'表面清洁复核',mend:'接带点检',rehouse:'换盘与低张力复核'}
const methodLabels = {rule:'工序阈值',knn:'三近邻'}
const stages = {proposed:'待审', authorised:'已签发', returned:'已退回'}
let reelCode = 'YT-26'

const header = (name,text) => `<header class="chapter"><h1>${h(name)}</h1><p>${h(text)}</p></header>`
const pct = fraction => `${(Number(fraction)*100).toFixed(1)}%`
const time = value => value ? new Date(value).toLocaleString('zh-CN',{hour12:false}) : '—'

function reels({reels,readings}) {
  const active = reels.filter(row=>!row.calibration)
  return header('馆藏卷台','以馆藏卷和原始捐赠批管理测样。参考库与待修卷分别建册。') + `
    <div class="archive-layout"><section><h2>待修卷</h2>${active.map(row=>`<a class="reel-box" href="#readings" data-reel="${h(row.code)}">
      <div class="spools" aria-hidden="true"><i></i><i></i></div><h3>${h(row.recording)}</h3><p>${h(row.code)} ／ ${h(row.donation)}</p>
      <span>${readings.filter(t=>t.reel===row.code).length} 个病征样段</span></a>`).join('')}</section>
      <section class="catalog-spine"><h2>参考卷与捐赠批</h2>${[...new Set(reels.filter(r=>r.calibration).map(r=>r.donation))].map(donor=>`<details><summary>${h(donor)} · ${reels.filter(r=>r.donation===donor).length} 卷</summary>
      ${reels.filter(r=>r.donation===donor).map(r=>`<a href="#readings" data-reel="${h(r.code)}">${h(r.code)} · ${h(r.recording)}</a>`).join('')}</details>`).join('')}</section></div>`
}

function readings({reels,readings},user) {
  const selected = reels.find(row=>row.code===reelCode) ?? reels[0]
  const rows = readings.filter(row=>row.reel===selected.code)
  const bench = user.role==='operator'&&!selected.calibration ? `<form data-action="excerpt"><label>卷内起点（秒）<input name="start_second" type="number" min="0" max="86400" required></label>
      <div class="counts"><label>间断<input name="dropout" type="number" min="0" max="30" required></label><label>脉冲<input name="snaps" type="number" min="0" max="20" required></label><label>残留<input name="residue" type="number" min="0" max="9" required></label></div>
      <button>记入样段</button><p role="status"></p></form>`
    : user.role==='reviewer'&&selected.calibration&&rows.length ? `<form data-action="correct"><label>补正样段<select name="excerpt">${rows.map(row=>`<option value="${h(row.code)}">${h(row.code)}</option>`).join('')}</select></label>
      <div class="counts"><label>间断<input name="dropout" type="number" min="0" max="30" required></label><label>脉冲<input name="snaps" type="number" min="0" max="20" required></label><label>残留<input name="residue" type="number" min="0" max="9" required></label></div>
      <label>签认工序<select name="known_route">${Object.entries(routeLabels).map(([key,label])=>`<option value="${h(key)}">${h(label)}</option>`).join('')}</select></label>
      <button>补正参考样段</button><p role="status"></p></form>`
    : empty('录入员可向待修卷添加样段，复核员可补正参考卷样段。')
  return header('样段观测','定位到卷内秒数，填写离线检测得到的计数。复核员补正参考样段的病征与签认工序，补正后封存的新版复验才采用。') + `
    <div class="reading-grid"><section><label class="choose">查看音带卷<select name="reel-filter">
      ${reels.map(row=>`<option ${row.code===selected.code?'selected':''} value="${h(row.code)}">${h(row.code)} · ${h(row.recording)}</option>`).join('')}</select></label>
    <div class="time-sheet">${rows.map(row=>`<article><time>${h(row.start_second)}s</time><div><h2>${h(row.code)}</h2><dl>
      <dt>间断</dt><dd>${h(row.dropout)}</dd><dt>脉冲断点</dt><dd>${h(row.snaps)}</dd><dt>残留等级</dt><dd>${h(row.residue)}</dd>
      </dl>${badge(routeLabels[row.known_route]??'待分诊')}</div></article>`).join('')||empty('此卷暂无样段。')}</div></section>
    <section class="bench"><h2>${user.role==='reviewer'&&selected.calibration?'补正参考样段':'新增样段'}</h2>${bench}</section></div>`
}

const scoreboard = row => row?.report ? `<div class="scoreboard">${Object.entries(row.report.accuracy).map(([method,accuracy])=>`<article>
  <h3>${methodLabels[method]} ${method===row.report.selected?badge('采用'):''}</h3><strong>${pct(accuracy)}</strong><meter min="0" max="1" value="${Number(accuracy)}"></meter>
  <small>${Object.entries(row.report.folds[method]).map(([fold,score])=>`折 ${h(fold)} · ${pct(score)}`).join(' ／ ')}</small></article>`).join('')}</div>` : ''

function lab({readings,manifests,effective},user) {
  const calibration = readings.filter(row=>row.known_route)
  const stateOf = row => {
    if (effective && row.id===effective.id) return '生效中'
    if (row.activated_at) return '已被新版取代'
    if (row.report) return row.report.accuracy[row.report.selected]>=.6 ? '达标 · 未启用' : '未达标'
    if (row.job_status==='failed') return '复验失败'
    return '复验中'
  }
  return header('分藏批复验','同批收进一种折号，后台按送审快照计算每折留出的分类准确率。新版达标即启用，旧版晚完成不顶替。') + `
  <section class="score-sheet"><h2>生效版 · ${h(effective?.label ?? '暂无')}</h2>
  ${effective ? `<p>第 ${h(effective.id)} 版 · 封存 ${h(time(effective.sealed_at))} · 启用 ${h(time(effective.activated_at))}</p>${scoreboard(effective)}` : empty('暂无生效复验版，工位暂不能开卡。')}</section>
  <section><h2>版本记录</h2>${manifests.map(row=>`<article class="order"><p class="ticket-id">第 ${h(row.id)} 版 · 封存 ${h(time(row.sealed_at))}</p>
    <h3>${h(row.label)}</h3>${badge(stateOf(row))}
    ${row.report?`<p>${Object.entries(row.report.accuracy).map(([method,accuracy])=>`${methodLabels[method]} ${pct(accuracy)}`).join(' ／ ')}</p>`:''}
    ${row.job_status==='failed'?`<p>失败原因：${h(row.job_error??'后台计算失败')}</p>`:''}
    ${user.role==='reviewer'&&row.job_status==='failed'&&!row.report?`<form data-action="retry" data-version="${h(row.id)}"><button>重试此版复验</button><p role="status"></p></form>`:''}</article>`).join('')||empty('暂无复验清单。')}</section>
  ${user.role==='reviewer' ? `<details class="bench manifest"><summary>封存新版复验清单</summary><form data-action="manifest">
    <label>清单名称<input name="label" required maxlength="60"></label>
    <div class="donor-folds">${[...new Set(calibration.map(row=>row.donation))].map((donor,index)=>`<article><h3>${h(donor)}</h3><label>折号<select name="donor:${h(donor)}">${[1,2,3].map(fold=>`<option ${index===fold-1?'selected':''}>${fold}</option>`).join('')}</select></label>
    <small>${calibration.filter(row=>row.donation===donor).length} 个签认样段</small></article>`).join('')}</div>
    <button>封存并提交复验</button><p role="status"></p></form></details>` : ''}`
}

function cards({cards,readings,effective},user) {
  const waiting = readings.filter(row=>!row.known_route&&!cards.some(card=>card.excerpt===row.code))
  return header('工序卡','工序卡记录触发的规则或最近参考样段。新版复验启用后，未签发的旧卡退回，按生效版重算建议后再签发。') + `
    <div class="card-layout"><section class="issued"><h2>工序票据</h2>${cards.map(row=>`<article class="order"><p class="ticket-id">${h(row.excerpt)} · 依据 ${h(row.evaluation_label)}（第 ${h(row.evaluation)} 版）</p>
      <h3>${routeLabels[row.route]}</h3>${badge(stages[row.stage])}<p>${h(row.explanation)}</p>
      ${row.stage==='returned' ? `<p>退回原因：${h(row.returned_reason)}</p>${user.role==='operator' ? `<form data-action="repropose" data-excerpt="${h(row.excerpt)}"><button>按生效版重算建议</button><p role="status"></p></form>` : ''}` : ''}
      ${row.authoriser ? `<p>签发 ${h(row.authoriser)}</p>` : (row.stage==='proposed'&&user.role==='reviewer' ? `<form data-action="approve" data-card="${h(row.id)}"><button>签发开工</button><p role="status"></p></form>` : '')}</article>`).join('')||empty('录入员可选待处理样段生成建议。')}</section>
    <section class="bench"><h2>准备工序建议</h2>${user.role==='operator'&&waiting.length&&effective ? `<form data-action="propose">
      <p>依据生效版：${h(effective.label)}（第 ${h(effective.id)} 版）</p>
      <label>待处理样段<select name="excerpt">${waiting.map(row=>`<option>${h(row.code)}</option>`).join('')}</select></label>
      <button>开立待审工序卡</button><p role="status"></p></form>` : empty(effective?'须同时有待处理样段与录入员权限。':'暂无生效复验版，待复核员封存并启用新版后开卡。')}</section></div>`
}

const views = {reels,readings,lab,cards}

async function render(page,outlet,user,flash='') {
  const extension = {rights,preservation,delivery}[page]
  if (extension) return extension(outlet, user)
  const data = await api(root+'/catalog')
  if (!outlet.isConnected) return
  outlet.innerHTML = (flash?'<p role="status" data-type="success"></p>':'')+views[page](data,user)
  if (flash) outlet.querySelector('[data-type=success]').textContent = flash
  outlet.querySelectorAll('[data-reel]').forEach(el=>el.onclick=()=>reelCode=el.dataset.reel)
  const filter=outlet.querySelector('[name=reel-filter]')
  if (filter) filter.onchange=()=>{
    reelCode = filter.value
    render(page,outlet,user).catch(error=>filter.after(error.message))
  }
  const correctForm = outlet.querySelector('form[data-action=correct]')
  if (correctForm) {
    const fill = () => {
      const row = data.readings.find(item=>item.code===correctForm.elements.excerpt.value)
      if (row) for (const key of ['dropout','snaps','residue','known_route']) correctForm.elements[key].value = row[key]
    }
    correctForm.elements.excerpt.onchange = fill
    fill()
  }
  outlet.querySelectorAll('form[data-action]').forEach(form=>{form.onsubmit=async event=>{
    event.preventDefault()
    const input=Object.fromEntries(new FormData(form))
    const button=form.querySelector('button')
    button.disabled=true
    try {
      switch(form.dataset.action) {
        case 'excerpt':
          await api(`${root}/reels/${encodeURIComponent(reelCode)}/excerpt`, 'POST',input)
          break
        case 'correct':
          await api(`${root}/excerpts/${encodeURIComponent(input.excerpt)}/correct`,'POST',{
            dropout:Number(input.dropout),snaps:Number(input.snaps),residue:Number(input.residue),known_route:input.known_route})
          break
        case 'manifest': {
          const assignments=data.readings.filter(row=>row.known_route).map(row=>({excerpt:row.code,fold:Number(input[`donor:${row.donation}`])}))
          const reply=await api(root+'/manifests','POST',{label:input.label,assignments})
          await waitJob(reply.job_id)
          break
        }
        case 'retry': {
          const reply=await api(`${root}/manifests/${form.dataset.version}/retry`,'POST')
          await waitJob(reply.job_id)
          break
        }
        case 'propose':
          await api(root+'/cards','POST',input)
          break
        case 'repropose':
          await api(root+'/cards','POST',{excerpt:form.dataset.excerpt})
          break
        case 'approve':
          await api(`${root}/cards/${form.dataset.card}/authorise`,'POST')
          break
      }
      await render(page,outlet,user,'记录已更新。')
    } catch(error) { notice(form.querySelector('[role=status]'),error.message,true) }
    finally { button.disabled=false }
  }})
}
mount({title:'卷带修复台',kicker:'潮声档案馆 · 声音载体修复',pages,render})
