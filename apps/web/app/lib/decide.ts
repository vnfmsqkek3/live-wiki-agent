// 결재 처리 (결재함·문서 상세 공용). 사유는 prompt로 받고, 결과 문장을 돌려준다. 취소하면 undefined
import { api, ApiError } from './api';

export async function decideApproval(id: string, decision: 'APPROVE' | 'REJECT'): Promise<{ status?: 'APPROVED' | 'REJECTED'; msg: string } | undefined> {
  const reason = prompt(decision === 'APPROVE' ? '승인 사유를 적어주세요' : '반려 사유를 적어주세요');
  if (!reason) return;
  try {
    const r = await api<{ status: 'APPROVED' | 'REJECTED' }>('POST', `/v1/approvals/${id}/decision`, { decision, reason });
    return { status: r.status, msg: r.status === 'APPROVED' ? '승인했습니다. 색인이 끝나면 검색에 나타납니다.' : '반려했습니다. 작성자에게 사유가 전달됩니다.' };
  } catch (e) {
    const x = e as ApiError;
    return { msg: x.message.startsWith('unclassified') ? x.message.replace(/^unclassified: /, '') : x.status === 409 ? '검토 이후 파일이 바뀌었거나, 이미 처리됐거나, 본인이 올린 문서입니다(본인 문서는 승인할 수 없음).' : x.message };
  }
}

/** 출처 불일치 문서 반려: 승인 대상이 아니므로 결재가 아니라 출처 검토 결과로 처리 */
export async function rejectSource(docId: string): Promise<{ status?: 'REJECTED'; msg: string } | undefined> {
  const reason = prompt('반려 사유를 적어주세요 (예: 공식 원본과 승인 기준 금액이 다름)');
  if (!reason) return;
  try {
    await api('POST', `/v1/documents/${docId}/source-review`, { decision: 'REJECT', reason });
    return { status: 'REJECTED', msg: '반려했습니다. 이 문서는 게시되지 않으며 작성자에게 사유가 전달됩니다.' };
  } catch (e) { return { msg: (e as ApiError).message }; }
}
