import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRetriever, retrievalWorkerEnv } from "../lib/retrieval.mjs";

test("retrieval worker does not inherit model keys and keeps cache HOME unchanged", () => {
  const environment = {
    HOME: "/synthetic-home",
    PATH: "/synthetic-bin",
    LANG: "C.UTF-8",
    MODEL_API_KEY: "synthetic",
    OPENAI_API_KEY: "synthetic",
    access_token: "synthetic",
    DB_PASSWORD: "synthetic",
    CLOUD_CREDENTIAL: "synthetic",
    MY_SECRET: "synthetic",
    MODEL_BASE_URL: "https://example.invalid",
    DEEPSEEK_API_KEY: "synthetic",
  };
  const result = retrievalWorkerEnv(environment, {
    root: "/private-corpus",
    db: "/private-corpus/index.sqlite",
  });
  assert.equal(result.HOME, environment.HOME);
  assert.equal(result.PATH, environment.PATH);
  assert.equal(result.QIZHULOU_ROOT, "/private-corpus");
  assert.equal(result.HF_HUB_OFFLINE, "1");
  for (const name of Object.keys(environment).filter(
    (name) => name !== "HOME" && name !== "PATH" && name !== "LANG",
  ))
    assert.equal(result[name], undefined);
});

test("missing corpus is explicit and does not start a model or download", async () => {
  const retriever = createRetriever({ root: "", db: "" });
  assert.equal(retriever.status().configured, false);
  assert.deepEqual((await retriever.search("应急资金怎么安排？")).sources, []);
  assert.match(
    (await retriever.search("应急资金怎么安排？")).retrieval.warning,
    /尚未配置/,
  );
  retriever.close();
});

test("invalid and excessive questions never reach private retrieval", async () => {
  const retriever = createRetriever({ root: "", db: "" });
  for (const input of [null, {}, "", " ", "资".repeat(1201)]) {
    const answer = await retriever.search(input);
    assert.equal(answer.sources.length, 0);
    assert.match(answer.retrieval.warning, /1200/);
  }
  retriever.close();
});

test("private corpus filter and speaker attribution use source text, not publisher", () => {
  const scriptPath = fileURLToPath(
    new URL("../scripts/retrieve.py", import.meta.url),
  );
  const program = String.raw`
import importlib.util,json,sqlite3,tempfile,pathlib,sys
spec=importlib.util.spec_from_file_location('retrieval',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as temp:
 db=pathlib.Path(temp)/'test.sqlite';c=sqlite3.connect(db)
 c.executescript('CREATE TABLE docs(doc_id TEXT,source TEXT,title TEXT,published_at TEXT,url TEXT,extra TEXT);CREATE TABLE segments(seg_id TEXT,doc_id TEXT,n INTEGER,text TEXT,anchor TEXT,speaker TEXT,start_ms INTEGER);')
 docs=[('book-ch01','book','合成测试书',None,None,None),('tr-3','transcript','合成旧起朱楼',None,None,None),('tr-other','transcript','起朱楼字样不代表属于该播客',None,None,json.dumps({'播客':'另一个节目'})),('zs-talk','zsxq','合成多人对谈',None,None,json.dumps({'作者':'大卫翁','类型':'talk'})),('zs-qa','zsxq','合成问答',None,None,json.dumps({'作者':'提问人','类型':'q&a'})),('zs-unknown','wx','合成读者感想',None,None,json.dumps({'作者':'读者甲'}))]
 c.executemany('INSERT INTO docs VALUES(?,?,?,?,?,?)',docs)
 bodies={'zs-talk':['陈鹏：先整理家庭资产与现金流，再考虑长期目标。','这个安排还应结合个人的责任与期限。','再根据需要比较不同资产的作用。','大卫翁：我也想补充另一种看法。'],'zs-qa':['【提问】某人：这里是提问人的私人家庭资料。','【回答】大卫翁：回答应当和实际现金流约束联系起来。'],'zs-unknown':['大卫翁的这本书让我开始整理家庭现金流，也让我重新认识应急资金的作用。','这仍然是读者的感想，不能沿用一个猜测的说话人。'],'book-ch01':['合成第一段。','合成第二段。','合成第三段。']}
 for did,texts in bodies.items():
  for n,text in enumerate(texts,1):c.execute('INSERT INTO segments VALUES(?,?,?,?,?,?,?)',(did+':'+str(n),did,n,text,'第'+str(n)+'段',None,None))
 c.commit();c.close();r=m.Retriever(temp,str(db),'keyword')
 assert 'tr-other' not in r.docs and 'tr-3' in r.docs
 class Stub:
  def __init__(self):self.doc_segments={did:[dict(x) for x in r.conn.execute('SELECT * FROM segments WHERE doc_id=? ORDER BY n',(did,))] for did in r.docs}
  def get_context(self,sid,radius=1):
   did,n=sid.rsplit(':',1);n=int(n)
   return {'segments':[{'segmentId':x['seg_id'],'text':x['text'],'anchor':x['anchor'],'isMatch':x['n']==n} for x in self.doc_segments[did] if abs(x['n']-n)<=radius]}
 r.searcher=Stub();r.rows={x['seg_id']:x for segs in r.searcher.doc_segments.values() for x in segs}
 turn=r.context('zs-talk:3');assert turn['speaker']=='陈鹏' and '第1段' in turn['attribution'] and '相邻段' in turn['attribution']
 unknown=r.context('zs-unknown:1');assert unknown['speaker'] is None
 assert r.context('zs-unknown:2')['speaker'] is None
 qa=r.context('zs-qa:2');assert qa['speaker']=='大卫翁' and '私人家庭资料' not in qa['text'] and qa['author']=='大卫翁（回答）'
 assert len(turn['text'])<=1500 and turn['id']=='zs-talk:3' and 'zs-talk:3' in turn['anchor']
 try:r.conn.execute('DELETE FROM docs');raise AssertionError('write unexpectedly allowed')
 except sqlite3.OperationalError:pass
 print(json.dumps({'corpus':True,'attribution':True,'privateQuestionOmitted':True,'readOnly':True}))
`;
  const stdout = execFileSync(
    process.env.QIZHULOU_PYTHON || process.env.PYTHON || "python3",
    ["-c", program, scriptPath],
    {
      encoding: "utf8",
      timeout: 10000,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    },
  );
  assert.deepEqual(JSON.parse(stdout), {
    corpus: true,
    attribution: true,
    privateQuestionOmitted: true,
    readOnly: true,
  });
});
