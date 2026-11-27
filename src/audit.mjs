import { get, run } from './db.mjs';
import { bad, day, field, now, number, Problem } from './domain.mjs';

export const maxImport = 25 * 1024 * 1024;
export const sources = ['api','chat','logs'];
export const pricing = {monthly: {amount:1200, interval:'month'}, annual:{amount:9900, interval:'year'}};
const rates = {
  'gpt-6.2-astra':[8,40], 'gpt-6.2-sol':[2,10], 'gpt-6-astra':[10,50],
  'gpt-6.1-sol':[2,10], 'gpt-6.1-terra':[1,5], 'gpt-6-luna':[0.1,0.5]
};
const topicRules = [
  ['Localization', /translat|localiz|localis|cantonese|繁體|翻譯|翻译|번역/iu],
  ['Code & technical', /debug|refactor|typescript|javascript|python|sql\b|code\b|API\b|程式|代码|코드/iu],
  ['Research & analysis', /research|compar(e|ison)|analy[sz]|forecast|investigate|研究|分析|분석/iu],
  ['Marketing & writing', /draft|writ(e|ing)|rewrite|caption|campaign|newsletter|copy\b|文案|撰寫|작성/iu],
  ['Summaries & extraction', /summar|extract|classif|format|tagging|摘要|总结|요약/iu]
];
const concise = /\b(summar\w*|extract\w*|classif\w*|format\w*|translate\w*|rewrite|proofread)\b|摘要|翻譯|翻译|번역|요약/iu;
const sensitive = /\b(confidential|secret|internal only|private key|pii|customer list|unreleased|proprietary|password|medical|legal|financial|patient|passport|credential)\b|機密|机密|密碼|비밀/iu;
const complex = /\b(multi[- ]step|strateg\w*|security|ambigui\w*|market sizing|architecture|legal|medical|financial|audit|reason\w*|debug)\b/iu;
const deliverables = {
  'Localization':'One labeled version per requested locale. Verify names, dates, prices, numbers and offer terms.',
  'Marketing & writing':'One draft with a clear CTA, the requested tone and a stated length limit. Preserve all supplied facts.',
  'Research & analysis':'Separate findings, assumptions, evidence gaps and next decisions. Cite only sources supplied or verified.',
  'Code & technical':'Provide the smallest useful change, relevant verification steps, and any unresolved edge cases.',
  'Summaries & extraction':'Return the requested fields only. Use null for missing values and omit unsupported inferences.',
  'Other':'Specify the exact format, length and acceptance criteria.'
};
const intl = new Intl.NumberFormat('en-US');
const has = value => value !== null && value !== undefined;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const usdEstimate = (model,input,output) => {
  const rate = rates[model] || rates[String(model).replace(/-\d{4}-\d{2}-\d{2}$/,'')];
  return rate && has(input) && has(output) ? (rate[0]*input+rate[1]*output)/1e6 : null;
};
const date = value => new Date(value).toISOString().slice(0,10);
const classify = text => topicRules.find(([,rule])=>rule.test(text))?.[0] || 'Other';
const textTokens = text => {
  // Character-based text heuristic. Count CJK characters separately to avoid using an English ratio for them.
  const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
  const remaining = text.replace(cjk,'');
  return Math.ceil((text.length-remaining.length)*1.4 + remaining.length/4);
};
const epoch = value => typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 4.1e9 ? value*1000 : null;
const sumKnown = values => values.some(has) ? values.reduce((total,value)=>total+(value ?? 0),0) : null;

async function pages(fetcher, path, key, start, end, groups, signal) {
  const endpoint = new URL('https://api.openai.com/v1/organization/'+path);
  for (const [name,value] of Object.entries({start_time:start,end_time:end,bucket_width:'1d',limit:30})) endpoint.searchParams.set(name,value);
  for (const group of groups) endpoint.searchParams.append('group_by',group);
  const buckets = [];
  const seen = new Set();
  try {
    do {
      const response = await fetcher(endpoint,{headers:{Authorization:'Bearer '+key},signal,redirect:'error'});
      if ([401,403].includes(response.status)) throw new Problem(422,'OpenAI did not authorize this key. Create an organization Admin API key as an organization owner.');
      if (response.status === 429) throw new Problem(503,'OpenAI is limiting usage requests. Try again shortly.');
      if (!response.ok) throw new Problem(502,'OpenAI could not return usage data. Try again shortly.');
      const result = await response.json();
      if (!Array.isArray(result.data) || result.data.some(item=>!Array.isArray(item.results) || !epoch(item.start_time))) throw new Error('Unexpected data');
      buckets.push(...result.data);
      if (!result.has_more) return buckets;
      if (typeof result.next_page !== 'string' || seen.has(result.next_page) || seen.size >= 12) throw new Error('Pagination limit');
      seen.add(result.next_page);
      endpoint.searchParams.set('page',result.next_page);
    } while (true);
  } catch (error) {
    if (error instanceof Problem) throw error;
    throw new Problem(502,'The OpenAI usage import could not be completed. Please retry.');
  }
}

export async function connectOpenAI(rawKey,fetcher=fetch,clock=now()) {
  const key = field(rawKey,'Admin API key',300);
  if (!/^sk-admin-[A-Za-z0-9_-]+$/.test(key)) bad('Enter an OpenAI organization Admin API key beginning with sk-admin-.');
  const end = Math.floor(clock/day)*day/1000;
  const start = end-30*86400;
  const abort = new AbortController();
  const signal = AbortSignal.any([abort.signal,AbortSignal.timeout(20_000)]);
  try {
    const [usage,costs] = await Promise.all([
      pages(fetcher,'usage/completions',key,start,end,['model'],signal),
      pages(fetcher,'costs',key,start,end,['line_item'],signal)
    ]);
    return apiReport(usage,costs,start,end);
  } finally { abort.abort(); }
}

function apiReport(usage,costs,start,end) {
  const daily = new Map(Array.from({length:30},(_,i)=>[date((start+i*86400)*1000),{tokens:0,cost:null}]));
  const modelMap = new Map();
  const costMap = new Map();
  const addAmount = (bucket,currency,amount) => bucket.set(currency,(bucket.get(currency)||0)+amount);
  const totals = new Map();
  let totalTokens = 0;
  let totalRequests = 0;
  for (const bucket of usage) {
    const rollup = daily.get(date(bucket.start_time*1000));
    if (!rollup) continue;
    for (const row of bucket.results) {
      const name = typeof row.model === 'string' ? row.model : 'Unknown';
      const model = modelMap.get(name) || {name,input:0,output:0,requests:0,cached:0};
      const input = count(row.input_tokens);
      const output = count(row.output_tokens);
      const requests = count(row.num_model_requests);
      model.input += input;
      model.output += output;
      model.cached += count(row.input_cached_tokens);
      model.requests += requests;
      modelMap.set(name,model);
      rollup.tokens += input+output;
      totalTokens += input+output;
      totalRequests += requests;
    }
  }
  for (const bucket of costs) {
    const rollup = daily.get(date(bucket.start_time*1000));
    if (!rollup) continue;
    for (const row of bucket.results) {
      const amount = row.amount?.value;
      const currency = row.amount?.currency?.toUpperCase();
      if (!Number.isFinite(amount) || !/^[A-Z]{3}$/.test(currency || '')) throw new Problem(502,'OpenAI returned incomplete cost data. Please retry.');
      addAmount(totals,currency,amount);
      const label = typeof row.line_item === 'string' ? row.line_item : 'Other charges';
      const rollupKey = JSON.stringify([label,currency]);
      costMap.set(rollupKey,{label,currency,amount:(costMap.get(rollupKey)?.amount || 0)+amount});
      if (currency === 'USD') rollup.cost = (rollup.cost || 0)+amount;
    }
  }
  const models = [...modelMap.values()].sort((a,b)=>(b.input+b.output)-(a.input+a.output));
  return {
    source:'api', from:date(start*1000), to:date((end-1)*1000), tokens:totalTokens, requests:totalRequests,
    cost:totals.get('USD') ?? (totals.size ? null : 0), currencies:[...totals], time:null,
    models, costItems:[...costMap.values()].sort((a,b)=>b.amount-a.amount),
    daily:[...daily].map(([date,entry])=>({date,...entry})),
    insights: models.slice(0,5).map(model=>({
      name:model.name, share:totalTokens ? Math.round(100*(model.input+model.output)/totalTokens) : 0,
      cachedPct:model.input ? Math.round(100*model.cached/model.input) : null
    }))
  };
}

export function importAudit(source,raw,clock=now()) {
  let input;
  try { input = JSON.parse(raw.replace(/^\uFEFF/,'')); } catch { bad('Upload a valid JSON file. Extract the ChatGPT ZIP first.'); }
  if (source === 'logs') return promptReport(source,logs(input));
  if (source === 'chat') return promptReport(source,chat(input,clock));
  bad('Choose an available import source.');
}

function logs(input) {
  if (!Array.isArray(input) || input.length > 5000 || !input.length) bad('Use a JSON array of 1–5,000 request records.');
  const seen = new Set();
  return input.flatMap((row,i)=>{
    if (!row || typeof row !== 'object' || Array.isArray(row)) bad('Request '+(i+1)+' is invalid.');
    const label = 'Request '+(i+1);
    const event = field(row.event_id,label+' event ID',160);
    if (seen.has(event)) return [];
    seen.add(event);
    if (typeof row.timestamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(row.timestamp) || !Number.isFinite(Date.parse(row.timestamp))) {
      bad(label+' needs an ISO timestamp with a timezone.');
    }
    const prompt = field(row.prompt,label+' prompt',60000);
    const model = field(row.model,label+' model',120);
    const numeric = (name,max=1e9,integer=true) => number(row[name],label+' '+name,{max,integer});
    return [{
      prompt, model, at:Date.parse(row.timestamp), topic:field(row.topic,label+' topic',80,false)||classify(prompt),
      input:numeric('input_tokens'),output:numeric('output_tokens'),time:numeric('latency_ms',86_400_000),active:numeric('active_ms',86_400_000),
      cost:numeric('cost_usd',1e6,false), reviewedPublic:row.public_data === true
    }];
  });
}

function chat(input,clock) {
  if (!Array.isArray(input) || !input.length) bad('Upload conversations.json from your ChatGPT export.');
  const end = clock;
  const start = end - 30*day;
  const records = [];
  const seen = new Set();
  for (const conversation of input) {
    const mapping = conversation?.mapping;
    if (!mapping || typeof mapping !== 'object' || typeof conversation.current_node !== 'string') continue;
    const chain = [];
    const visited = new Set();
    let cursor = conversation.current_node;
    while (typeof cursor === 'string' && !visited.has(cursor) && Object.hasOwn(mapping,cursor)) {
      visited.add(cursor);
      const node = mapping[cursor];
      if (!node || typeof node !== 'object') break;
      const message = node.message;
      const role = message?.author?.role;
      if ((role==='assistant'||role==='user') && !message.metadata?.is_visually_hidden_from_conversation) chain.push({message,id:message.id || cursor});
      cursor = node.parent;
    }
    chain.reverse();
    let entry = null;
    for (const {message,id} of chain) {
      const value = (Array.isArray(message.content?.parts) ? message.content.parts.filter(part=>typeof part==='string').join('\n') : '').trim();
      const at = epoch(message.create_time);
      if (message.author.role==='user') {
        entry = null;
        if (!at || at<start || at>end || !value || seen.has(id)) continue;
        seen.add(id);
        entry = {prompt:value, at, input:textTokens(value), output:null, time:null, cost:null, model:null, topic:classify(value)};
        records.push(entry);
        if (records.length > 5000) bad('This export contains more than 5,000 text prompts in the last 30 days. Use a smaller export or import selected request logs.');
      } else if (entry && value) {
        entry.output = (entry.output ?? 0)+textTokens(value);
        const elapsed = at ? at-entry.at : null;
        if (!entry.model) entry.model = field(message.metadata?.model_slug,'Model',120,false) || null;
        if (!has(entry.time) && elapsed >= 0 && has(elapsed) && elapsed <= 300000) entry.time = elapsed;
      }
    }
  }
  if (!records.length) bad('The export has no supported text prompts in the last 30 days. Check the file and export date.');
  return records;
}

function promptReport(source,records) {
  const groups = new Map();
  const prompts = new Map();
  let from = Infinity;
  let to = -Infinity;
  for (const row of records) {
    from = Math.min(from,row.at);
    to = Math.max(to,row.at);
    const group = groups.get(row.topic) || [];
    groups.set(row.topic,group);
    group.push(row);
    const key = row.topic+'\0'+row.prompt.trim().replace(/\s+/gu,' ');
    const cluster = prompts.get(key) || [];
    prompts.set(key,cluster);
    cluster.push(row);
  }
  const summarize = rows => ({
    requests:rows.length,
    tokens:sumKnown(rows.map(row=>sumKnown([row.input,row.output]))),
    cost:sumKnown(rows.map(row=>row.cost)),
    time:sumKnown(rows.map(row=>row.time)),
    active:sumKnown(rows.map(row=>row.active)),
    coverage:{
      tokens:rows.filter(row=>has(row.input)&&has(row.output)).length,
      cost:rows.filter(row=>has(row.cost)).length,
      time:rows.filter(row=>has(row.time)).length,
      active:rows.filter(row=>has(row.active)).length
    }
  });
  const rank = (a,b)=>(b.cost||0)-(a.cost||0)||(b.time||0)-(a.time||0)||(b.tokens||0)-(a.tokens||0)||b.requests-a.requests;
  const topics = [...groups].map(([name,rows])=>({name,...summarize(rows)})).sort(rank);
  const promptDetails = [...prompts.values()].map(rows=>{
    const first = rows[0];
    const prompt = first.prompt.slice(0,1600);
    const summary = summarize(rows);
    const isComplex = rows.some(row=>complex.test(row.prompt));
    const task = isComplex ? 'complex' : rows.every(row=>concise.test(row.prompt)) ? 'routine' : 'standard';
    const route = {complex:'gpt-6.2-astra',routine:'gpt-6-luna',standard:'gpt-6.2-sol'}[task];
    const baseline = rows.map(row=>source==='logs' ? usdEstimate(row.model,row.input,row.output) : null);
    const candidate = rows.map(row=>source==='logs' ? usdEstimate(route,row.input,row.output) : null);
    const savings = baseline.every(has)&&candidate.every(has) ? Math.max(0,sumKnown(baseline)-sumKnown(candidate)) : null;
    const publicOnly = !rows.some(row=>sensitive.test(row.prompt));
    const cleaned = first.prompt.split(/\n/u).map(line=>line.trim()).filter(Boolean).join('\n').slice(0,1600);
    const changes = [];
    if (first.prompt.length > 900) changes.push('Move reusable background to a brief or cached prefix. Pass only details that change.');
    if (!/\b(word|bullet|format|JSON|paragraph|character|output|return)\b|格式|段落/iu.test(first.prompt)) changes.push('Specify the response format and a length limit to reduce rework and output tokens.');
    if (summary.requests >= 3) changes.push('Turn repeated instructions into a saved template with named inputs.');
    if (!changes.length) changes.push('Keep the constraints and run a side-by-side quality check before changing the model.');
    const spec = Object.hasOwn(deliverables,first.topic) ? deliverables[first.topic] : deliverables.Other;
    return {...summary,topic:first.topic,prompt,truncated:first.prompt.length>1600,task,route,savings,changes,
      models:[...new Set(rows.map(row=>row.model).filter(Boolean))],
      gemini: task==='routine' && publicOnly && (source==='chat'||rows.every(row=>row.reviewedPublic)),
      rewrite:textTokens(first.prompt)>1000 ? 'Task: [state the goal]\nInputs: [only case-specific facts]\nRequirements: [copy all must-keep constraints]\nDeliverable: [format and maximum length]\nAcceptance checks: '+spec+'\nFlag missing information. Check the output against the requirements.' :
        cleaned+'\n\nDeliverable: '+spec+'\nCheck the output against every requirement and flag missing information.'
    };
  }).sort(rank);
  const workflows = topics.filter(topic=>topic.requests>=3 && topic.name!=='Other').slice(0,6).map(topic=>{
    const matching = promptDetails.filter(prompt=>prompt.topic===topic.name);
    const repeated = matching.filter(prompt=>prompt.requests>=3);
    const later = matching[0];
    return {name:topic.name,requests:topic.requests,repeats:repeated.reduce((n,item)=>n+item.requests,0),
      example:later?.prompt.slice(0,140),validation:Object.hasOwn(deliverables,topic.name) ? deliverables[topic.name] : deliverables.Other,grade:repeated.length ? 'Automation candidate' : 'Template first'};
  });
  return {source,from:date(from),to:date(to),...summarize(records),topics:topics.slice(0,100),promptDetails:promptDetails.slice(0,50),
    uniquePrompts:promptDetails.length,workflows};
}

export function snapshot(db,user,source) {
  const row = get(db,'SELECT imported,report FROM audit_snapshots WHERE user_id=? AND source=?',user,source);
  return row ? {...JSON.parse(row.report),imported:row.imported} : null;
}

export function saveSnapshot(db,user,report,imported=now()) {
  run(db,'INSERT INTO audit_snapshots VALUES (?,?,?,?) ON CONFLICT(user_id,source) DO UPDATE SET imported=excluded.imported, report=excluded.report',
    user,report.source,imported,JSON.stringify(report));
}

export function sampleReport(clock=now()) {
  const records = [
    ['Translate the public event announcement into Traditional Chinese and Korean. Keep the date and price exact.','Localization','gpt-6.2-sol',20,3340,920,1600,true],
    ['Draft a short newsletter for members with a reminder and a single call to action.','Marketing & writing','gpt-6.2-sol',16,8140,1670,4300,false],
    ['Compare the strategy risks and model three scenarios. Flag overall exposure and dependencies.','Research & analysis','gpt-6.2-astra',8,17100,5850,12500,false],
    ['Extract every public release date into JSON.','Summaries & extraction','gpt-6.2-astra',24,9200,600,1850,true]
  ].flatMap(([prompt,topic,model,repeats,input,output,time,reviewedPublic],i)=>Array.from({length:repeats},(_,j)=>({
    prompt,topic,model,input,output,time,cost:usdEstimate(model,input,output),reviewedPublic,at:clock-(i+j+1)*day
  })));
  return promptReport('logs',records);
}

export const metricNumber = value => has(value) ? intl.format(value) : 'Unavailable';
