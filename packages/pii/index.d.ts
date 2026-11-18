/** 개인을 식별하는 값만 (사용자 결정 11/17: 이름·나이·주소는 대상 아님) */
export type PiiType = 'RRN' | 'FOREIGNER_NO' | 'PASSPORT' | 'DRIVER_LICENSE' | 'CARD' | 'ACCOUNT' | 'CUSTOMER_NO';
export interface PiiSpan { type: PiiType; start: number; end: number; certain: boolean /* false → 사람 검토 */ }
/** 화면·Finding 메시지용 한글 이름 */
export declare const PII_NAME: Record<PiiType, string>;
export declare function rrnChecksumOk(d: string): boolean;
export declare function luhnOk(d: string): boolean;
export declare function detectPii(text: string): PiiSpan[];
/** 확실·불확실 모두 마스킹 (불확실은 사람 검토에서 해제 가능) */
export declare function mask(text: string, spans: PiiSpan[]): string;
