'use strict';
/* 本地单测：大模型配置中心 + 点赞任务（不碰网络） */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Store } = require('../store');
const llm = require('../llm-config');
const { createLikes } = require('../collect-likes');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-test-'));
const store = new Store(path.join(tmp, 'db.json'));

let n = 0;
const hub = {
  enqueue(payload, meta) {
    n++;
    const job = {
      id: 'dj' + n, kind: payload.kind || 'collect', platform: payload.platform,
      status: 'pending', notBefore: payload.notBefore, createdAt: new Date().toISOString(),
      likeId: (meta && meta.likeId) || '', commentId: (meta && meta.commentId) || ''
    };
    store.push('collect_jobs', job);
    return job;
  },
  ready() { return true; }
};

function assert(cond, msg) { if (!cond) throw new Error('FAIL: ' + msg); }

/* 1) 旧格式升级：单对象 → 一条默认记录，key 脱敏 */
store.data.llm_cfg = [{ provider: 'openai', base_url: 'https://api.openai.com/v1', api_key: 'sk-abcdefghijklmn', model: 'gpt-4o-mini' }];
store.save(true, 'llm_cfg');
const l1 = llm.list(store);
assert(l1.items.length === 1, 'legacy 应该升级成 1 条');
assert(l1.items[0].isDefault === true, 'legacy 应该自动成为默认');
assert(l1.items[0].keyMask.indexOf('sk-abc') === 0, 'key 要保留前 6 位');
assert(l1.items[0].keyMask.indexOf('klmn') > 0, 'key 要保留后 4 位');
assert(l1.items[0].keyMask.indexOf('defghij') < 0, '中间部分不能出现');
assert(l1.llmReady === true, '有可用模型时 llmReady=true');
console.log('legacy ->', l1.items[0].id, l1.items[0].keyMask);

/* 2) 新增第二个模型，只给 comment 用；resolve 按用途分流 */
const r2 = llm.save(store, {
  name: '评论专用', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  api_key: 'sk-qqqqqqqqqqqq', model: 'qwen-plus', purposes: ['comment'], temperature: 0.95
});
assert(!r2.error, '新增应成功');
const l2 = r2.list;
assert(l2.items.length === 2, '应该有 2 条');
const cComment = llm.resolve(store, 'comment');
const cGeo = llm.resolve(store, 'geo');
assert(cComment.model === 'qwen-plus', 'comment 用途应命中评论专用模型，实际=' + cComment.model);
assert(cGeo.model === 'gpt-4o-mini', 'geo 用途应回落到默认模型，实际=' + cGeo.model);
console.log('resolve comment=', cComment.model, ' geo=', cGeo.model);

/* 3) 通用模型仍然兜住没有专用模型的用途（配置评论专用不能把 GEO 搞挂） */
const legacyId = l1.items[0].id;
assert(llm.resolve(store, 'geo').model === 'gpt-4o-mini', 'geo 应继续用通用模型');
llm.enable(store, legacyId, false);
assert(llm.resolve(store, 'geo').model === 'qwen-plus', '通用模型停用后 geo 应兜底到唯一可用模型');
llm.enable(store, legacyId, true);

/* 4) 停用专用模型：comment 回到通用；全停则无可用模型 */
llm.enable(store, r2.item.id, false);
assert(llm.resolve(store, 'comment').model === 'gpt-4o-mini', '停用后 comment 应回落默认');
llm.enable(store, legacyId, false);
assert(llm.resolve(store, '') === null || llm.resolve(store, '').source === 'env', '全停后不应再有库内模型');
console.log('all disabled -> ready=', llm.list(store).llmReady);

/* 5) 重新启用 + 保存时留空 key 不覆盖 */
llm.enable(store, legacyId, true);
const r3 = llm.save(store, { id: legacyId, model: 'gpt-4o', api_key: '' });
assert(!r3.error, '留空 key 应允许保存');
assert(r3.item.hasKey === true, '留空 key 不应清空已存 key');
assert(r3.item.model === 'gpt-4o', '模型名应更新');
console.log('update keep key ->', r3.item.model, r3.item.keyMask);

/* 6) 参数校验 */
assert(llm.save(store, { name: 'x', base_url: 'ftp://bad', api_key: 'k', model: 'm' }).error.code === 'BAD_BASE_URL', '非法地址应被拒');
assert(llm.save(store, { name: 'x', base_url: 'https://a.com/v1', api_key: '', model: 'm', id: 'nope' }).error.code === 'NOT_FOUND', '未知 id 应被拒');

/* 7) 删除 */
const r4 = llm.remove(store, r2.item.id);
assert(!r4.error && r4.list.items.length === 1, '删除后应剩 1 条');

/* 8) 点赞：排期递增 / 去重 / 回执 */
const likes = createLikes(store, hub);
const a = likes.create({ platform: 'douyin', url: 'https://www.douyin.com/video/1', title: 'A' });
assert(!a.error, '点赞应建任务');
const b = likes.create({ platform: 'douyin', url: 'https://www.douyin.com/video/2', title: 'B' });
assert(!b.error, '第二条应建任务');
assert(b.job.notBefore > a.job.notBefore, '第二条应排在第一条之后');
const dup = likes.create({ platform: 'douyin', url: 'https://www.douyin.com/video/1', title: 'A' });
assert(dup.error.code === 'LIKE_QUEUED', '同作品重复点赞应被拦，实际=' + (dup.error && dup.error.code));

const key = likes.noteKeyOf({ platform: 'douyin', url: 'https://www.douyin.com/video/1' });
const job = store.data.collect_jobs.filter((j) => j.likeId === key)[0];
likes.onJobDone(Object.assign({}, job, {
  status: 'done',
  result: { like: { liked: true, already: false } }
}));
assert(likes.list({}).items[0].status === 'sent', '回执后应为 sent');
const again = likes.create({ platform: 'douyin', url: 'https://www.douyin.com/video/1', title: 'A' });
assert(again.error.code === 'ALREADY_LIKED', '已赞后应拒绝，实际=' + (again.error && again.error.code));
console.log('likes total=', likes.list({}).total, 'cap=', likes.cap);

/* 9) 执行过程：progress 逐步追加、重复同一步只更新时间、finish 保留 steps */
const { DeviceHub } = require('../collect-devices');
const hub2 = new DeviceHub(store, {});
const job2 = hub2.enqueue({ kind: 'comment', platform: 'douyin', url: 'https://www.douyin.com/video/9', text: 'hi' }, { commentId: 'douyin|9' });
assert(Array.isArray(job2.steps) && job2.steps.length === 0, '新任务 steps 应为空数组');
hub2.progress(job2.id, { step: 'open', status: 'run', msg: '打开页面' });
hub2.progress(job2.id, { step: 'open', status: 'ok', msg: '已打开' });
hub2.progress(job2.id, { step: 'locate', status: 'ok', msg: '找到输入框' });
hub2.progress(job2.id, { step: 'locate', status: 'ok', msg: '找到输入框（重复）' });
const j2 = hub2.job(job2.id);
assert(j2.steps.length === 3, '重复上报同一步不应新增，实际=' + j2.steps.length);
assert(j2.steps[2].msg === '找到输入框（重复）', '重复上报应更新 msg');
assert(j2.status === 'claimed', 'progress 后任务应为 claimed');
hub2.finish(job2.id, { ok: false, code: 'NO_SEND', message: '没找到发送按钮', steps: j2.steps });
const j3 = hub2.job(job2.id);
assert(j3.result.steps.length >= 3, 'finish 应保留 steps');
assert(j3.steps[j3.steps.length - 1].step === 'fail', '失败任务末尾应补 fail 步');
console.log('steps ->', j3.steps.map((x) => x.step + ':' + x.status).join(' '));

console.log('\nALL LLM/LIKE CHECKS PASSED');
