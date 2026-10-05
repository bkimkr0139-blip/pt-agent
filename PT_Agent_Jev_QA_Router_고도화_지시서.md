# PPT 발표 에이전트 Jev QA Router 고도화 지시서
## Jev QA Router → LLM 호출 최소화 → Decision Log → 폐루프 Threshold 최적화

**대상 시스템:** PPT 발표 에이전트  
**기준 문서:** `pt-agent-시스템문서-2026-10-05.md`  
**목표:** 기존 QA 체인의 응답 지연과 불필요한 LLM 호출을 줄이고, 반복 사용 시 판단 일관성과 서비스 품질을 높이기 위해 Jev 기반 Decision Layer를 우선 적용한다.

---

# 1. 고도화 목적

현재 PPT 발표 에이전트의 QA 체인은 다음 구조를 가진다.

```text
질문
 ↓
STT
 ↓
RAG 검색
 ↓
LLM 답변
 ↓
TTS
 ↓
발표 재개
```

현재 시스템은 이미 다음 기반을 갖추고 있다.

- 질문 접수 즉시 RAG 검색과 LLM 응답을 병렬 처리
- 참조 0건일 경우 LLM 호출 생략
- 근거 부족 시 `[[NO_ANSWER]]` 센티널을 이용한 정직 거절
- QA 이벤트를 `eval/qa_log.jsonl`에 기록
- RAG miss를 `eval/rag-miss.jsonl`에 적재
- 자동 지식 습득 폐루프
- 무결 감시자와 TTS 정책 자동 조정
- 모델 평가 및 Trial/Rollback 체계

이번 고도화에서는 이 구조를 유지하면서, **LLM 앞에 Jev 기반 QA Router를 추가한다.**

핵심 목표는 다음 4가지다.

1. **Jev QA Router 도입**
2. **불필요한 LLM 호출 최소화**
3. **Decision Log 축적**
4. **운영 데이터 기반 Threshold 자동 최적화**

---

# 2. 이번 단계의 핵심 원칙

## 2.1 Jev는 답변 생성기가 아니다

Jev는 다음 역할만 담당한다.

- 질문 답변 가능성 판단
- RAG 근거 충분성 판단
- LLM 필요 여부 판단
- 응답 경로 선택
- 거절 여부 판단
- 발표 인터럽트 필요성 판단

실제 자연어 답변은 기존 LLM이 담당한다.

## 2.2 기존 QA 품질 보호

현재 시스템에서 검증된 다음 기능은 제거하지 않는다.

- `[[NO_ANSWER]]` 센티널
- RAG miss 처리
- 정직 거절 멘트
- 지식 자동 습득
- QA 3중 병렬 체인
- TTS 프리캐시
- QA 로그
- 무결 루프

Jev는 이 기능들을 대체하는 것이 아니라 **앞단 Decision Layer**로 추가한다.

## 2.3 Human / Safe Fallback 우선

Jev 판단이 불확실한 경우에는 자동 실행을 강제하지 않는다.

```text
confidence >= high_threshold
    → Jev 판단 실행

mid_threshold <= confidence < high_threshold
    → 기존 LLM Judge 또는 기존 QA 경로

confidence < mid_threshold
    → 보수적 경로
       - LLM
       - NO_ANSWER
       - Human Review
```

---

# 3. 목표 QA 아키텍처

```text
사용자 질문
   │
   ▼
STT
   │
   ▼
RAG Retrieval
   │
   ▼
┌──────────────────────┐
│   Jev QA Router      │
└──────────────────────┘
   │
   ├─ DIRECT
   ├─ RAG_SHORT
   ├─ RAG_LLM
   ├─ LLM_REASON
   ├─ NO_ANSWER
   └─ ASK_CLARIFY
   │
   ▼
응답 경로 실행
   │
   ▼
화면 표시 / TTS
   │
   ▼
발표 재개
   │
   ▼
Decision Log
   │
   ▼
Threshold Optimization
```

---

# 4. Jev QA Router의 입력

Jev에는 자유형 전체 시스템 상태를 무제한 전달하지 말고, QA 판단에 필요한 최소 상태만 전달한다.

## 4.1 필수 입력

```text
question_text
current_slide_title
current_slide_notes
presentation_title
rag_reference_count
rag_top_score
rag_top_chunks
rag_source_types
previous_qa_state
session_mode
```

## 4.2 선택 입력

```text
question_length
question_type_hint
contains_domain_term
contains_pronoun
previous_question_summary
knowledge_origin
knowledge_confidence
```

---

# 5. Jev QA Router의 출력 스키마

Jev 판단 결과는 반드시 구조화된 형태로 반환한다.

```json
{
  "route": "RAG_LLM",
  "answerability": "answerable",
  "rag_sufficiency": "medium",
  "requires_reasoning": true,
  "requires_llm": true,
  "should_interrupt": true,
  "should_acquire_knowledge": false,
  "confidence": 0.91,
  "reason_code": "RAG_RELEVANT_COMPLEX"
}
```

---

# 6. Route 정의

## 6.1 DIRECT

조건:

- 이미 검증된 고정 지식 존재
- 짧은 정의형 질문
- LLM 추론 불필요
- 재사용 빈도가 높은 FAQ

예:

```text
"SSOT가 뭐예요?"
```

처리:

```text
검증된 지식 → 화면 표시 → TTS
```

LLM 호출 없음.

## 6.2 RAG_SHORT

조건:

- RAG 근거 충분
- 단순 요약 또는 짧은 설명
- 복잡한 추론 불필요

처리 방식:

- 기존 RAG 결과에서 짧은 응답 템플릿 생성
- 필요 시 소형 로컬 모델 또는 deterministic formatter 사용
- 30B LLM 호출은 하지 않음

## 6.3 RAG_LLM

조건:

- RAG 근거 존재
- 설명·비교·맥락 해석 필요

처리:

```text
RAG context
   ↓
기존 qwen3:30b-a3b
   ↓
답변
```

## 6.4 LLM_REASON

조건:

- RAG만으로 충분하지 않으나
- 질문이 발표 주제와 관련 있고
- 추론형 답변이 필요

예:

```text
"이 방식과 기존 SI 방식의 가장 큰 차이는 무엇인가요?"
```

## 6.5 NO_ANSWER

조건:

- 발표 범위 밖
- RAG 근거 부족
- 신뢰 가능한 답변 불가
- 보안 또는 정책상 답변 금지

처리:

- LLM 호출하지 않음
- 기존 `RAG_MISS_MSG` 즉시 사용
- 필요 시 지식 자동 습득 판단으로 연결

## 6.6 ASK_CLARIFY

조건:

- 질문이 지나치게 모호함
- 대명사 또는 이전 질문 참조가 불분명함
- 동일 용어가 여러 개념으로 해석 가능함

처리:

짧은 재질문 멘트를 프리캐시로 재생한다.

예:

```text
"어느 부분을 말씀하시는지 한 번만 더 구체적으로 질문해 주세요."
```

---

# 7. 기존 QA 3중 병렬 체인과의 통합

현재 QA는 질문 수신 즉시 다음을 병렬 수행한다.

1. 정적 추임새 재생
2. RAG 검색
3. LLM 답변 생성

이번 고도화에서는 LLM 생성 시점을 변경한다.

## 개선 구조

```text
질문 접수
 ├─ ① 정적 추임새 즉시 재생
 ├─ ② RAG 검색
 └─ ③ Jev QA Router 준비

RAG 결과 도착
   ↓
Jev 판단
   ↓
LLM 필요 여부 결정
```

즉, **LLM은 Jev가 필요하다고 판단한 경우에만 호출한다.**

---

# 8. LLM 호출 최소화 정책

## 8.1 LLM 호출 금지 조건

```text
route == DIRECT
route == RAG_SHORT
route == NO_ANSWER
route == ASK_CLARIFY
```

## 8.2 LLM 호출 조건

```text
route == RAG_LLM
route == LLM_REASON
```

## 8.3 목표 KPI

초기 목표:

```text
기존 QA 100건 기준
LLM 호출률 100% 또는 이에 가까운 수준
        ↓
목표
LLM 호출률 40~60%
```

정확한 목표치는 운영 로그를 기반으로 조정한다.

---

# 9. Decision Log 신규 추가

신규 원장:

```text
eval/decision_log.jsonl
```

각 QA마다 Jev 판단을 반드시 기록한다.

---

# 10. Decision Log 스키마

```json
{
  "timestamp": "2026-10-05T18:30:00+09:00",
  "session_id": "session_xxx",
  "ppt_id": "ppt_xxx",
  "slide_no": 7,
  "question": "SSOT가 무슨 뜻인가요?",
  "rag": {
    "reference_count": 3,
    "top_score": 0.536,
    "sources": ["auto", "deck"]
  },
  "decision": {
    "route": "DIRECT",
    "answerability": "answerable",
    "rag_sufficiency": "high",
    "requires_llm": false,
    "should_interrupt": true,
    "confidence": 0.94,
    "reason_code": "KNOWN_TERM"
  },
  "execution": {
    "llm_called": false,
    "response_ms": 320,
    "tts_ms": 840
  },
  "outcome": {
    "rag_miss": false,
    "user_reasked": false,
    "user_interrupted": false,
    "fallback": false,
    "error": null
  }
}
```

---

# 11. Decision 결과와 실제 결과 비교

모든 판단은 사후 결과와 비교한다.

```text
Jev: DIRECT
실제: 사용자 재질문 없음
결과: success
```

```text
Jev: NO_ANSWER
실제: 동일 질문 재질문 + 관리자 판단상 답변 가능
결과: false_negative
```

```text
Jev: RAG_SHORT
실제: 사용자가 추가 설명 요청
결과: under_routed
```

---

# 12. Decision 품질 지표

관리자 화면에 다음 지표를 추가한다.

```text
Decision Accuracy
LLM Avoidance Rate
False Reject Rate
False Accept Rate
Re-ask Rate
Fallback Rate
Average QA Latency
P95 QA Latency
```

---

# 13. Threshold 구조

신규 정책 파일:

```text
eval/decision_policy.json
```

예:

```json
{
  "version": 1,
  "answer_high": 0.85,
  "answer_mid": 0.65,
  "no_answer_high": 0.90,
  "llm_required_high": 0.75,
  "direct_answer_high": 0.92,
  "interrupt_high": 0.80
}
```

---

# 14. Threshold 적용 규칙

```text
route = DIRECT
AND confidence >= direct_answer_high
→ DIRECT 실행

route = DIRECT
AND confidence < direct_answer_high
→ RAG_LLM fallback
```

```text
route = NO_ANSWER
AND confidence >= no_answer_high
→ 즉시 정직 거절

route = NO_ANSWER
AND confidence < no_answer_high
→ 기존 LLM Judge
```

---

# 15. 폐루프 Threshold 최적화

기존 `integrity_watch.py`와 동일한 철학을 따른다.

다만 TTS 정책과 Decision 정책은 파일을 분리한다.

```text
tts_policy.json
decision_policy.json
```

---

# 16. Decision Optimizer 신규 모듈

신규 파일:

```text
works/pt-agent/decision_optimizer.py
```

역할:

```text
decision_log.jsonl 읽기
 ↓
최근 QA 판단과 실제 결과 비교
 ↓
false accept / false reject 계산
 ↓
threshold 조정 후보 생성
 ↓
안전 범위 내 자동조정
```

---

# 17. 자동 최적화 안전장치

## 17.1 Clamp

```text
direct_answer_high
0.85 ~ 0.98

no_answer_high
0.85 ~ 0.99

llm_required_high
0.60 ~ 0.90
```

## 17.2 최소 샘플

```text
minimum_samples = 50
```

## 17.3 Cooldown

동일 Threshold는 최소 30분 간격으로만 변경한다.

## 17.4 최대 변경 폭

```text
1회 최대 ±0.03
```

---

# 18. 폐루프 조정 예

## False Reject 증가

```text
NO_ANSWER
→ 실제 답변 가능
```

이 비율이 증가하면:

```text
no_answer_high += 0.02
```

## False Accept 증가

```text
DIRECT/RAG_SHORT
→ 실제 답변 오류
```

증가 시:

```text
direct_answer_high += 0.02
```

## LLM 호출 과다

정확도는 유지되는데 LLM 호출률이 높으면:

```text
direct_answer_high -= 0.01
```

단, 정확도 하락 시 즉시 롤백.

---

# 19. 목표 SLA

## QA 응답 시작

```text
P50 < 500ms
```

정적 추임새 또는 즉시 답변 시작 기준.

## DIRECT 경로

```text
P50 < 700ms
P95 < 1.5s
```

## RAG_SHORT

```text
P50 < 1.5s
```

## RAG_LLM

기존 대비 평균 지연 20% 이상 감소를 목표로 한다.

---

# 20. GPU 사용 개선 목표

Jev 적용 전후 다음을 비교한다.

```text
LLM 호출 수
LLM 총 실행시간
TTS truncation 빈도
TTS queue wait
GPU 평균 점유시간
```

Jev 도입 후 LLM 호출 감소가 TTS 안정성에도 긍정적 영향을 주는지 반드시 검증한다.

---

# 21. 기존 `[[NO_ANSWER]]` 유지

Jev가 `RAG_LLM` 또는 `LLM_REASON`을 선택한 경우에도 기존 LLM 프롬프트의 `[[NO_ANSWER]]` 센티널 정책을 유지한다.

```text
Jev 1차 판단
+
LLM 2차 자기검증
```

의 이중 안전망을 유지한다.

---

# 22. 지식 자동 습득과의 연계

Jev 출력에 다음 필드를 추가할 수 있다.

```text
should_acquire_knowledge
```

예:

```text
route = NO_ANSWER
domain_relevance = high
should_acquire_knowledge = true
```

→ 기존 `/api/knowledge/acquire` 호출

---

# 23. 지식 자동 습득 제외

다음은 자동 습득하지 않는다.

- 발표와 무관한 일반 질문
- 일시적 질문
- 개인정보 관련 질문
- 정책상 저장 금지 질문
- 신뢰도 낮은 질문

---

# 24. 발표 흐름 제어

Jev가 다음도 판단할 수 있다.

```text
should_interrupt
answer_length
resume_policy
```

예:

```json
{
  "should_interrupt": true,
  "answer_length": "short",
  "resume_policy": "resume_current_slide"
}
```

---

# 25. 발표 상태와 QA Route

```text
발표 중
→ DIRECT / RAG_SHORT 선호

발표 일시정지 상태
→ RAG_LLM / LLM_REASON 허용

발표 종료 후
→ 긴 설명 가능
```

---

# 26. 관리자 화면 추가

기존 관리자 콘솔에 신규 탭 추가:

```text
🧭 Decision Router
```

표시 항목:

- Jev 상태
- 최근 Decision
- Route 분포
- LLM Avoidance Rate
- 평균 응답시간
- False Reject
- False Accept
- Threshold
- 정책 버전
- 최근 자동조정

---

# 27. 실시간 상태 표시

예:

```text
Decision Policy v4

DIRECT         31%
RAG_SHORT      18%
RAG_LLM        27%
LLM_REASON      9%
NO_ANSWER      12%
ASK_CLARIFY     3%

LLM Avoidance 64%
```

---

# 28. 신규 파일 구조

```text
works/pt-agent/

  decision/
    jev_client.js
    decision_service.js
    decision_policy.js
    route_executor.js

  eval/
    decision_log.jsonl
    decision_policy.json
    decision_status.json

  decision_optimizer.py
```

---

# 29. 역할 분리

## `jev_client.js`
Jev API 호출만 담당.

## `decision_service.js`
입력 상태 조립 및 Decision Schema 관리.

## `decision_policy.js`
Threshold 및 fallback 규칙.

## `route_executor.js`
Decision에 따라 실제 기존 QA 함수 호출.

## `decision_optimizer.py`
운영 결과 기반 Threshold 최적화.

---

# 30. Provider 추상화

Jev를 코드에 직접 종속시키지 않는다.

인터페이스:

```text
DecisionProvider
```

구현:

```text
JevDecisionProvider
RuleDecisionProvider
LLMJudgeProvider
```

향후 로컬 Decision Model을 쉽게 교체할 수 있도록 한다.

---

# 31. Local First 정책 고려

기존 시스템은 Local First가 핵심 원칙이다.

따라서 Jev가 외부 API인 경우:

- PPT 원문 전체 전송 금지
- 전체 RAG Chunk 전송 최소화
- 개인정보 제거
- 최소 Context만 전달
- 로그에 외부 전송 필드 기록

가능하면 이후 `Local Decision Model`로 대체 가능한 구조를 유지한다.

---

# 32. 보안 로그

각 Jev 호출에 다음을 기록한다.

```text
provider
model
fields_sent
pii_detected
request_ms
response_ms
decision
confidence
```

---

# 33. 장애 Fallback

Jev 장애 시 발표는 중단되면 안 된다.

```text
Jev timeout
    ↓
기존 QA path
```

즉:

```text
RAG
 ↓
기존 LLM + [[NO_ANSWER]]
```

로 자동 fallback.

---

# 34. Jev Timeout

초기 제안:

```text
300ms
```

초과 시 Jev 결과를 기다리지 않고 기존 QA 경로 실행.

실측 후 조정.

---

# 35. Shadow Mode

초기 배포는 반드시 Shadow Mode로 수행한다.

```text
사용자에게는 기존 QA 실행
+
백그라운드에서 Jev 판단만 수행
+
decision_log 적재
```

최소 100 QA 이상 결과 수집 후 실사용 전환.

---

# 36. Shadow 평가 항목

```text
기존 결과와 Jev Route 일치율
NO_ANSWER 적중률
LLM 필요 판단 정확도
DIRECT 가능 질문 비율
평균 Jev latency
오류율
```

---

# 37. Canary 전환

Shadow 검증 후:

```text
10%
→ 25%
→ 50%
→ 100%
```

단계적 전환.

문제 발생 시 즉시:

```text
DecisionProvider = LLMJudge
```

로 롤백.

---

# 38. A/B 테스트

A 그룹:

```text
기존 QA
```

B 그룹:

```text
Jev QA Router
```

비교:

```text
응답시간
LLM 호출률
재질문율
거절 정확도
TTS 오류
사용자 중단
QA 완료율
```

---

# 39. 성공 기준

## 성능

- LLM 호출 30% 이상 감소
- 평균 QA 응답 지연 20% 이상 감소

## 품질

- False Reject 5% 이하
- False Accept 3% 이하
- 재질문율 기존 이하

## 안정성

- Jev 장애 시 QA 중단 0건
- 발표 흐름 중단 증가 없음

---

# 40. 1차 개발 범위

이번 단계에서는 다음만 구현한다.

```text
1. Jev QA Router
2. Decision Provider abstraction
3. Route Executor
4. Decision Log
5. Shadow Mode
6. 기본 Threshold
7. 관리자 Decision Dashboard
8. Threshold Optimizer
9. 기존 QA fallback
```

---

# 41. 이번 단계에서 제외

다음은 후속 단계로 넘긴다.

- TTS pre-split Jev 판단
- 발표 전체 Workflow Router
- STT 품질 판단
- 모델 자동 선택
- Agent orchestration
- 전체 발표 Script 생성 Decision
- 지식 자동 습득 고급 scoring

---

# 42. 구현 순서

1. 기존 QA 코드 분석
2. DecisionProvider interface 구현
3. Jev Shadow Mode 구현
4. `decision_log.jsonl` 적재
5. 100건 이상 실제 QA 수집
6. Jev 판단 성능 분석
7. Threshold 확정
8. Canary 활성화
9. LLM Avoidance 활성화
10. Threshold Optimizer 활성화

---

# 43. Claude Code 작업 지시문

다음 요구사항을 기준으로 기존 PPT 발표 에이전트 코드를 수정한다.

> 현재 QA 체인을 전수 분석하고, RAG와 LLM 사이에 Jev 기반 Decision Layer를 추가하라.
>
> Jev는 답변을 생성하지 않고 다음만 판단한다.
>
> - answerability
> - RAG sufficiency
> - LLM required
> - route
> - interrupt 여부
> - knowledge acquisition 여부
>
> route는 다음 6개로 제한한다.
>
> `DIRECT`, `RAG_SHORT`, `RAG_LLM`, `LLM_REASON`, `NO_ANSWER`, `ASK_CLARIFY`
>
> 모든 판단은 `eval/decision_log.jsonl`에 기록한다.
>
> 초기에는 Shadow Mode로만 동작하게 하고 기존 QA 결과에 영향을 주지 않는다.
>
> 최소 100건 이상의 실제 QA 로그를 확보한 뒤 Decision Accuracy, False Reject, False Accept, LLM Avoidance Rate, 평균 응답시간을 계산한다.
>
> 이후 confidence threshold 기반 Canary Mode를 활성화한다.
>
> Jev 장애나 timeout 발생 시 기존 QA 체인으로 즉시 fallback해야 하며 발표 흐름이 중단되어서는 안 된다.
>
> 기존 `[[NO_ANSWER]]`, RAG miss, 자동 지식 습득, TTS 프리캐시, QA 로그, 무결 루프는 유지한다.
>
> threshold는 별도 `decision_policy.json`으로 관리하고, 운영 결과에 따라 `decision_optimizer.py`가 안전 범위 안에서 점진적으로 조정하도록 한다.
>
> 모든 변경은 테스트 가능하고 롤백 가능해야 한다.

---

# 44. 최종 목표

이번 고도화의 목적은 Jev 자체를 도입하는 것이 아니다.

목표는:

```text
빠른 판단
    ↓
불필요한 LLM 호출 감소
    ↓
GPU 경합 감소
    ↓
QA 응답속도 향상
    ↓
TTS 안정성 개선
    ↓
Decision Log 축적
    ↓
Threshold 최적화
    ↓
반복 사용할수록 안정적인 PT Agent
```

를 만드는 것이다.

최종적으로 PPT 발표 에이전트는 단순한

```text
STT → LLM → TTS
```

구조가 아니라,

```text
STT
 ↓
RAG
 ↓
Decision Layer
 ↓
필요할 때만 LLM
 ↓
TTS
 ↓
Operational Feedback
 ↓
Decision Policy Optimization
```

의 **폐루프 기반 저지연 음성 AI Agent 구조**로 발전시킨다.
