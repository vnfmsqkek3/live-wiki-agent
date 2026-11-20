// 결재 처리 (결재함·문서 상세 공용). 의견은 화면의 입력란에서 받는다(브라우저 prompt 쓰지 않음 — 11/18 dev 시험: 헷갈리고 자동화도 막힘)
import { api, ApiError } from './api';

export async function decideApproval(id: string, decision: 'APPROVE' | 'REJECT' | 'REVALIDATE', reason: string): Promise<{ status?: 'APPROVED' | 'REJECTED'; msg: string } | undefined> {
  if (!reason.trim()) return { msg: decision === 'APPROVE' ? '결재 의견을 한 줄 적거나 고르세요.' : decision === 'REVALIDATE' ? '다시 검증할 이유를 적어 주세요.' : '반려 사유를 적어 주세요.' };
  try {
    const r = await api<{ status: 'APPROVED' | 'REJECTED' }>('POST', `/v1/approvals/${id}/decision`, { decision, reason });
    return { status: r.status, msg: decision === 'REVALIDATE' ? '재검증을 요청했습니다. 문서가 작성자 검토 단계로 돌아가 AI 검사를 다시 거칩니다.' : r.status === 'APPROVED' ? '승인했습니다. 색인이 끝나면 검색에 나타납니다.' : '반려했습니다. 작성자에게 사유가 전달됩니다.' };
  } catch (e) {
    const x = e as ApiError;
    return { msg: x.message.startsWith('unclassified') ? x.message.replace(/^unclassified: /, '') : x.status === 409 ? '검토 이후 파일이 바뀌었거나 이미 처리된 결재입니다. 새로고침해 주세요.' : x.status === 403 ? '본인이 올린 문서는 관리자만 승인할 수 있습니다.' : x.message };
  }
}

/** 출처 불일치 문서 반려: 승인 대상이 아니므로 결재가 아니라 출처 검토 결과로 처리 */
export async function rejectSource(docId: string, reason: string): Promise<{ status?: 'REJECTED'; msg: string } | undefined> {
  if (!reason.trim()) return { msg: '반려 사유를 적어 주세요 (예: 공식 원본과 승인 기준 금액이 다름).' };
  try {
    await api('POST', `/v1/documents/${docId}/source-review`, { decision: 'REJECT', reason });
    return { status: 'REJECTED', msg: '반려했습니다. 이 문서는 게시되지 않으며 작성자에게 사유가 전달됩니다.' };
  } catch (e) { return { msg: (e as ApiError).message }; }
}

/** 자주 쓰는 결재 의견 */
export const APPROVE_CHIPS = ['원문과 근거 조문을 확인함', '내용 확인함, 이상 없음'];
