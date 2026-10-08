#!/usr/bin/env python3
"""Read-only qizhulou retrieval. JSON-lines worker; source corpus stays private.

Requires the existing qizhulou environment, not a copied corpus or new index.
No network, ingestion, index rebuild, or user-profile persistence is performed.
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import time

TOPICS = [
    (r'应急|备用|活钱|断粮|失业|丢.{0,3}工作|饭碗|收入中断|安全垫|储备', '应急 现金 储备 收入中断 流动性', r'应急|备用|储备|现金|流动性|失业'),
    (r'现金流|收支|结余|生活费|开销|支出|月光|存不住|存钱', '现金流 收入 支出 储蓄', r'现金流|收入|支出|储蓄|存钱'),
    (r'贷款|房贷|负债|债务|月供|还贷|还款|欠款', '贷款 债务 提前还贷 流动性', r'房贷|贷款|还贷|还款|负债|债务'),
    (r'职业|工资|奖金|收入|提成|工作|雇主|创业|人力|公司股票|行业风险', '人力资产 职业 收入 相关', r'人力|职业|收入|工作|创业|公司股票'),
    (r'首付|学费|留学|买房|教育|看病|医疗|养娃|目标|退休|养老|年后|年内|用途|期限|用钱', '目标 期限 家庭 流动性', r'目标|期限|家庭|退休|养老|买房|购房|首付|流动性'),
    (r'风险|冒险|扛得住|承受|亏损|波动|回撤|睡不着|焦虑|问卷|分数|年龄|认知边界', '风险 承受 心态 认知边界', r'风险|承受|亏损|波动|回撤|心态|认知'),
    (r'再平衡|再均衡|调仓|偏离|比例变|涨多|仓位变|占比|占.{0,6}(大头|多数|一半|比重)', '再平衡 比例 仓位 投资纪律', r'再平衡|比例|仓位|占比|纪律'),
    (r'追涨|杀跌|止盈|止损|死扛|卖掉|卖出|非卖品|退出|拿不住|纪律|复盘|定投', '投资纪律 复盘 止盈 止损 心理账户', r'纪律|复盘|止盈|止损|卖出|心理账户|非卖品|定投'),
    (r'分散|相关|集中|风险.{0,8}一起|单一|股债|多资产|一篮子', '分散配置 相关 资产组合', r'分散|相关|集中|配置|组合'),
    (r'费用|成本|费率|手续费|管理费', '投资 成本 费用', r'成本|费用|费率|手续费'),
    (r'通胀|购买力|贬值|通货膨胀', '通胀 购买力 资产', r'通胀|购买力|贬值|通货膨胀'),
    (r'保险|保障|保费|退保', '保险 保障 流动性', r'保险|保障|保费|退保'),
    (r'外币|币种|汇率|全球|跨境|海外', '全球配置 汇率 期限', r'全球|海外|汇率|币种|境外'),
    (r'货币基金|现金管理|债券|个券|固定收益|持有到期', '货币基金 债券 期限 收益', r'货币基金|债券|个券|固收|固定收益'),
    (r'锁定|锁.{0,4}年|不能取|取不出|赎回|封闭|动不了', '锁定 流动性 期限', r'流动性|锁定|赎回|封闭|期限'),
    (r'降息|宏观|经济|新闻|政策|趋势', '宏观 趋势 决策', r'宏观|经济|新闻|政策|趋势'),
    (r'黄金|金价', '黄金 配置 比例', r'黄金|金价'),
    (r'资产配置|怎么配置|如何配置|投资组合|财富规划|理财|金融投资', '资产配置 家庭 目标', r'资产配置|投资组合|财富规划|理财|家庭'),
]
LIVE = re.compile(r'(今天|今日|最新|明天|下周).{0,16}(持仓|持有|推荐|看好|价格|股价|涨|跌)|实时.{0,10}(持仓|价格|行情)|目标价')
STOP = re.compile(r'大卫翁|起朱楼宴宾客|请问|请教|一下|老师|是不是|为什么|怎么办|怎么|哪些|能不能|应该|可以|多少|什么|有没有|现在|我们|你们|他们|我的|你的|帮我|给我|告诉我|是不是|是否')
SPEAKERS = re.compile(r'大卫翁|Ricky|陈鹏|Amiee|知行小酒馆|雨白|孟岩|肖小跑|石磊')
# These three dialogue layouts were checked paragraph-by-paragraph in READING.md.
# Their extracted speaker labels lost colons; do not extend this exception to
# arbitrary articles merely because the publisher/subject is a known person.
INLINE_DIALOGUE_DOCS = {'zs-14422514242582422', 'wx-ef991ae8', 'zs-814214442824152'}
TURN_NAMES = r'(大卫翁|Ricky|陈鹏|Amiee|知行小酒馆|雨白)'

def turn_labels(text, doc_id):
    strict = re.compile(r'(?:^|[。！？\n])' + TURN_NAMES + r'[ \t]*(?:[:：]|\n)')
    labels = list(strict.finditer(text))
    if doc_id in INLINE_DIALOGUE_DOCS:
        inline = re.compile(r'(?:^|[。！？\n])' + TURN_NAMES + r'(?=对[，。！？\s]|没错|是的|我|其实|首先|所以|强相关|变得|那|好|嗯)')
        labels += list(inline.finditer(text))
    return sorted(labels, key=lambda item: item.start())


def select_docs(conn):
    """Same corpus=qizhulou predicate as the existing MCP server."""
    docs = {}
    for row in conn.execute('SELECT * FROM docs'):
        d = dict(row)
        try:
            extra = json.loads(d.get('extra') or '{}')
        except (ValueError, TypeError):
            extra = {}
        if d['source'] not in {'book', 'wx', 'episode', 'transcript', 'zsxq'}:
            continue
        if d['source'] in {'episode', 'transcript'}:
            if extra.get('播客') != '起朱楼宴宾客' and not (extra.get('播客') is None and re.fullmatch(r'(?:ep|tr)-\d+', d['doc_id'])):
                continue
        d['_extra'] = extra
        docs[d['doc_id']] = d
    return docs


class Retriever:
    def __init__(self, root, db, mode='keyword'):
        self.root, self.db = Path(root), Path(db)
        self.mode = mode
        self.conn = sqlite3.connect(self.db.resolve().as_uri() + '?mode=ro', uri=True)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute('PRAGMA query_only=ON')
        self.docs = select_docs(self.conn)
        self.searcher = None
        self.coverage = None
        self.warning = None
        self.vector_ready = False
        self.guides = json.loads((Path(__file__).resolve().parents[1] / 'data/sources.json').read_text())
        self.rows = {}
        self.eligible_indices = []
        self.eligible_texts = {}

    def status(self):
        return {'configured': True, 'ready': self.searcher is not None,
                'mode': 'hybrid' if self.vector_ready else 'keyword',
                'warning': self.warning, 'coverage': self.coverage,
                'corpus': 'qizhulou', 'documents': len(self.docs)}

    def initialize(self):
        if self.searcher is not None:
            return
        sys.path.insert(0, str(self.root))
        # Importing the library never calls its writable connect() helper.
        with contextlib.redirect_stdout(sys.stderr):
            from qizhulou.search import Searcher, tokenize
            from rank_bm25 import BM25Okapi
            class CorpusSearcher(Searcher):
                def refresh(inner):
                    # Keep a coherent in-memory source snapshot; reload on restart.
                    return

                def _build(inner):
                    # Reuse original ranking/context methods, scope in-memory tokens
                    # before construction rather than tokenizing unrelated podcasts.
                    inner._version = (inner.conn.execute('PRAGMA data_version').fetchone()[0], inner.conn.total_changes)
                    inner.docs = select_docs(inner.conn)
                    inner.doc_segments = {did: [] for did in inner.docs}
                    for row in inner.conn.execute('SELECT * FROM segments ORDER BY doc_id,n'):
                        if row['doc_id'] in inner.docs:
                            inner.doc_segments[row['doc_id']].append(dict(row))
                    tokens, refs = [], []
                    for did, segments in inner.doc_segments.items():
                        inner.docs[did]['segments'] = segments
                        for seg in segments:
                            words = tokenize(seg['text'])
                            if words:
                                tokens.append(words)
                                refs.append(seg)
                    inner.bm25 = BM25Okapi(tokens) if tokens else None
                    inner.seg_refs = refs
            self.searcher = CorpusSearcher(conn=self.conn, db_path=self.db)
        self.tokenize = tokenize
        for i, seg in enumerate(self.searcher.seg_refs):
            did = seg['doc_id']
            if did not in self.docs:
                continue
            sid = f"{did}:{seg['n']}"
            self.rows[sid] = seg
            # ShowNotes and chapter reading lists are discovery aids, not answers.
            if self.docs[did]['source'] == 'episode' or did.startswith('bookref-'):
                continue
            body = seg['text'].strip()
            if len(body) < 35 or body.startswith(('【提问】', '> 长文章', '来自：', '延伸阅读', '推荐理由')):
                continue
            self.eligible_indices.append(i)
            self.eligible_texts[sid] = seg['text']
        self.coverage = {'corpus': 'qizhulou', 'documents': len(self.docs),
                         'segments': len(self.rows), 'eligible': len(self.eligible_texts),
                         'indexed': None, 'stale': None, 'vectorAvailable': self.searcher.vector_index.available}
    def prepare_vectors(self):
        vector = self.searcher.vector_index
        if vector.available and not vector._loaded:
            with contextlib.redirect_stdout(sys.stderr):
                vector._load()
            vector_ids = set(vector.unique_seg_ids)
            texts = vector.source_texts or {}
            indexed = sum(texts.get(sid) == text for sid, text in self.eligible_texts.items())
            stale = sum(sid in vector_ids and texts.get(sid) != text for sid, text in self.eligible_texts.items())
            self.coverage.update(indexed=indexed, stale=stale, vectorAvailable=True,
                                 model=vector.model_name, dimensions=int(vector.embeddings.shape[1]))
            if indexed < len(self.eligible_texts):
                self.warning = '现有向量未覆盖全部有效原文；未覆盖或过期片段仍参与关键词检索。'

    def lexical(self, query, limit=160):
        tokens = self.tokenize(STOP.sub(' ', query))
        if not tokens:
            return []
        scores = self.searcher.bm25.get_scores(tokens)
        pairs = [(i, float(scores[i])) for i in self.eligible_indices if scores[i] > 0]
        pairs.sort(key=lambda pair: pair[1], reverse=True)
        return [(f"{self.searcher.seg_refs[i]['doc_id']}:{self.searcher.seg_refs[i]['n']}", score) for i, score in pairs[:limit]]

    def guided(self, question, groups):
        # Expert-read metadata is only a routing aid. Answers always fetch current
        # source text and neighbouring paragraphs from the private read-only DB.
        words = {w for w in self.tokenize(STOP.sub(' ', question)) if len(w) > 1}
        named = set(SPEAKERS.findall(question)) - {'大卫翁'}
        scored = []
        for card in self.guides:
            if card['docId'] not in self.docs:
                continue
            if named and card.get('speaker') not in named:
                continue
            focus = ' '.join(card['topics']) + ' ' + card['summary']
            overlap = sum(w in focus for w in words)
            topics = sum(bool(re.search(g[2], focus)) for g in groups)
            primary = sum(bool(g[1]) and any(topic.startswith(g[1].split()[0]) for topic in card['topics']) for g in groups)
            if overlap < 1 and primary < 1 and not named:
                continue
            score = overlap * 3 + topics * 2 + primary * 5 + (30 if named else 0)
            if any(g[1].startswith('现金流 ') for g in groups):
                score += 4 * sum(topic in {'三张表', '记账', '快照', '收支'} for topic in card['topics'])
            ranges = re.findall(r'(\d+)(?:[–—-](\d+))?', card['anchor'])
            ids = {f"{card['docId']}:{n}" for lo, hi in ranges for n in range(int(lo), int(hi or lo)+1)}
            expanded_words = {w for g in groups for w in g[1].split()}
            candidates = [(sid, 3*sum(w in self.rows[sid]['text'] for w in words) + 2*sum(w in self.rows[sid]['text'] for w in expanded_words)) for sid in ids if sid in self.eligible_texts]
            if any(g[1].startswith('现金流 ') for g in groups) and '三张表' in card['topics']:
                explanatory = [item for item in candidates if re.search(r'区别|分期|还款|实际流', self.rows[item[0]]['text'])]
                if explanatory:
                    candidates = explanatory
            if candidates:
                candidates.sort(key=lambda item: (-item[1], int(item[0].rsplit(':',1)[1])))
                scored.append((score, candidates[0][0]))
        scored.sort(reverse=True)
        return [sid for score, sid in scored[:3]]

    def search(self, question, mode=None):
        started = time.perf_counter()
        mode = mode or self.mode
        question = question.strip()[:1200]
        groups = [item for item in TOPICS if re.search(item[0], question)]
        if LIVE.search(question):
            return {'sources': [], 'retrieval': {'mode': 'none', 'warning': '本地资料不能核验实时持仓、行情或新的市场预测。', 'coverage': self.coverage}}
        if not groups and re.search(r'钱|财|收入|资金|基金|股票|账户|存款|银行|投资|还债|资产|收益|产品|本金|利率', question):
            groups = [(r'.', '', r'钱|财|收入|资金|基金|股票|账户|存款|银行|投资|还债|资产|收益|产品|本金|利率')]
        if not groups:
            return {'sources': [], 'retrieval': {'mode': 'none', 'warning': '未找到可定位的资产配置主题；请补充资金用途或具体问题。', 'coverage': self.coverage}}
        # A household cash balance question is about flows, not a career profile.
        # Keep human-capital routing only when the question explicitly raises it.
        if any(g[1].startswith('现金流 ') for g in groups) and not re.search(r'职业|创业|人力|雇主|行业|提成|奖金', question):
            groups = [g for g in groups if not g[1].startswith('人力资产 ')]
        self.initialize()
        raw = self.lexical(question)
        expanded = self.lexical(' '.join(item[1] for item in groups)) if mode != 'bm25' else []
        semantic = []
        if mode == 'hybrid' and self.coverage['vectorAvailable']:
            try:
                self.prepare_vectors()
                with contextlib.redirect_stdout(sys.stderr):
                    semantic = self.searcher.vector_index.search(question, eligible_seg_ids=list(self.eligible_texts), eligible_texts=self.eligible_texts, limit=180)
                self.vector_ready = True
            except Exception as exc:
                # Never download a missing encoder or pretend vector retrieval succeeded.
                self.warning = '本地语义模型不可用，已使用原文关键词与主题改写检索。'
                print(f'vector_unavailable:{type(exc).__name__}', file=sys.stderr)
        elif mode == 'hybrid':
            self.warning = '未配置现有向量索引，已使用原文关键词与主题改写检索。'
        actual_mode = 'hybrid' if semantic else ('bm25' if mode == 'bm25' else 'keyword-expanded')
        fused, semantic_scores, lexical_scores = {}, dict(semantic), dict(raw)
        for hits, weight in [(raw, 1.0), (expanded, 0.55), (semantic, 1.1)]:
            for rank, (sid, score) in enumerate(hits, 1):
                fused[sid] = fused.get(sid, 0.0) + weight / (60 + rank)
        # Keep two verified topic entrances alongside fresh lexical/semantic hits.
        # This avoids pretending semantic similarity alone proves relevance.
        if mode != 'bm25':
            for rank, sid in enumerate(self.guided(question, groups)):
                fused[sid] = fused.get(sid, 0.0) + (0.060 - rank * 0.004)
        ranked = sorted(fused, key=fused.get, reverse=True)
        sources, seen_docs, seen_text = [], set(), set()
        named_speakers = set(SPEAKERS.findall(question)) - {'大卫翁'}
        guided_ids = set(self.guided(question, groups)) if mode != 'bm25' else set()
        for sid in ranked:
            seg = self.rows[sid]
            body = seg['text']
            topic_hits = sum(bool(re.search(item[2], body)) for item in groups)
            lex = lexical_scores.get(sid, 0)
            sem = semantic_scores.get(sid, 0)
            # Calibrated on the small local evaluation, not a probability of truth.
            if not topic_hits or (sem < 0.43 and lex < 9 and sid not in guided_ids):
                continue
            if semantic and sem < 0.40 and sid not in dict(raw[:25]) and sid not in guided_ids:
                continue
            did = seg['doc_id']
            fingerprint = hashlib.sha256(re.sub(r'\s+', '', body).encode()).hexdigest()
            if did in seen_docs or fingerprint in seen_text:
                continue
            source = self.context(sid, question)
            if not source or (named_speakers and source['speaker'] not in named_speakers):
                continue
            sources.append(source)
            seen_docs.add(did)
            seen_text.add(fingerprint)
            if len(sources) == 4:
                break
        warning = self.warning
        if not sources:
            warning = '本次未找到超过相关性门槛的原文；这不证明作者从未讨论过该主题。'
        return {'sources': sources, 'retrieval': {'mode': actual_mode, 'warning': warning,
                'coverage': self.coverage, 'elapsedMs': round((time.perf_counter()-started)*1000)}}

    def context(self, sid, question=''):
        hit = self.rows[sid]
        d = self.docs[hit['doc_id']]
        raw = self.searcher.get_context(sid, radius=1)
        segments = [x for x in raw['segments'] if not x['text'].lstrip().startswith(('【提问】', '> 长文章'))]
        if not segments:
            return None
        # Keep the hit plus neighbouring source text, capped globally at 1500 chars.
        # For long ASR paragraphs take a centred excerpt instead of omitting the hit.
        entries = []
        for segment in segments:
            limit = 900 if segment['isMatch'] else 240
            text = segment['text']
            if len(text) > limit:
                words = [w for w in self.tokenize(STOP.sub(' ', question)) if len(w)>1]
                starts = range(0, max(1,len(text)-limit+1), 150)
                offset = max(starts, key=lambda start: sum(w in text[start:start+limit] for w in words))
                text = ('〔本段节选〕' if offset else '') + text[offset:offset+limit] + '〔节选止〕'
            entries.append(f"[{segment['segmentId']}｜{segment['anchor'] or '段落'}] {text}")
        text = '\n'.join(entries)[:1500]
        # A long preceding paragraph must never crowd out the matched passage.
        if f'[{sid}｜' not in text:
            return None
        speaker = hit.get('speaker') or None
        attribution = '原文上下文；文档发布者不等于本段说话人。'
        author = d['_extra'].get('作者') or None
        qa_answers = [s for s in self.searcher.doc_segments[d['doc_id']] if '【回答】大卫翁' in s['text']]
        if d['source'] == 'book':
            author, speaker = '大卫翁', '大卫翁'
            attribution = '大卫翁书面论述；段内引用他人观点时仍须按原文分别归属。'
        elif qa_answers and hit['n'] >= qa_answers[0]['n']:
            author, speaker = '大卫翁（回答）', '大卫翁'
            attribution = '正文明确标注的回答者为大卫翁；提问人不是回答作者。'
        elif not speaker:
            # Carry an explicit turn label forward; do not infer from publisher.
            turn = None
            for previous in self.searcher.doc_segments[d['doc_id']]:
                if previous['n'] >= hit['n']:
                    break
                labels = turn_labels(previous['text'], d['doc_id'])
                if labels:
                    last = labels[-1]
                    turn = (last.group(1), previous['n'], previous['text'][last.start():last.start()+150])
            current = turn_labels(hit['text'], d['doc_id'])
            if len(current) == 1 and current[0].start() == 0:
                speaker = current[0].group(1)
                attribution = f'命中段以{speaker}标签起始；相邻段可能是其他人发言。'
            elif not current and turn and hit['n'] - turn[1] <= 15:
                speaker = turn[0]
                attribution = f'命中段说话人沿用本篇第{turn[1]}段的{speaker}标签；相邻段仍按各自标签区分。'
                label_id = f"{d['doc_id']}:{turn[1]}"
                if not any(x['segmentId'] == label_id for x in segments):
                    text = (f'〔说话人上下文，第{turn[1]}段〕{turn[2]}\n' + text)[:1500]
            else:
                intro = ' '.join(s['text'] for s in self.searcher.doc_segments[d['doc_id']][:3])
                if d['source'] == 'transcript' and '我是大卫翁' in intro and not re.search(r'对话|嘉宾|串台|访谈', d['title'] + intro):
                    speaker = '大卫翁'
                    attribution = '单口转写开场自报大卫翁；转写可能有同音字，段内引述需另行归属。'
                else:
                    attribution = '节目或资料中讨论；本段具体说话人未可靠确认，不整体归因给发布者。'
        kind = {'book': 'book', 'wx': 'article', 'transcript': 'podcast'}.get(d['source'], 'qa' if qa_answers else 'podcast')
        limits = ['仅本次检索到的原文节选，不代表作者全部或当前立场。']
        if not d.get('published_at'):
            limits.append('本地库未记录发布日期。')
        if d['source'] == 'transcript':
            limits.append('ASR转写可能存在同音字和断句错误。')
        if d['source'] == 'zsxq':
            limits.append('原链接可能需要会员权限；完整正文不随代码公开。')
        if speaker is None:
            limits.append('不能根据发布者元数据断定具体发言人。')
        anchor = '；'.join(f"{s['anchor'] or '段落'}（{s['segmentId']}）" for s in segments)
        return {'id': sid, 'title': d['title'], 'date': d.get('published_at'), 'kind': kind,
                'docId': d['doc_id'], 'anchor': anchor, 'author': author, 'speaker': speaker,
                'attribution': attribution, 'summary': text, 'text': text, 'publicUrl': d.get('url'),
                'evidenceLimitations': ''.join(limits)}


def main():
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['TRANSFORMERS_OFFLINE'] = '1'
    os.environ.setdefault('TOKENIZERS_PARALLELISM', 'false')
    os.environ.setdefault('OMP_NUM_THREADS', '2')
    parser = argparse.ArgumentParser()
    parser.add_argument('--worker', action='store_true')
    parser.add_argument('--query')
    parser.add_argument('--mode', choices=['bm25', 'keyword', 'hybrid'], default=os.environ.get('QIZHULOU_RETRIEVAL_MODE', 'keyword'))
    args = parser.parse_args()
    root = os.environ.get('QIZHULOU_ROOT', '')
    db = os.environ.get('QIZHULOU_DB') or str(Path(root) / 'data/index.sqlite')
    if not root or not Path(root, 'qizhulou/search.py').is_file() or not Path(db).is_file():
        print(json.dumps({'error': 'corpus_unconfigured'}), flush=True)
        return
    engine = Retriever(root, db, args.mode)
    if args.query is not None:
        print(json.dumps(engine.search(args.query), ensure_ascii=False), flush=True)
        return
    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            if request.get('op') == 'status':
                result = engine.status()
            elif request.get('op') == 'search' and isinstance(request.get('question'), str):
                result = engine.search(request['question'], request.get('mode'))
            else:
                raise ValueError('invalid_request')
            print(json.dumps({'requestId': request.get('requestId'), 'result': result}, ensure_ascii=False), flush=True)
        except Exception as exc:
            print(f'retrieval_failure:{type(exc).__name__}', file=sys.stderr)
            print(json.dumps({'requestId': request.get('requestId'), 'error': 'retrieval_failed'}), flush=True)


if __name__ == '__main__':
    main()
