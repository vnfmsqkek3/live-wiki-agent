/** 진행바 (등록·검토 화면 공용). text = 지금 단계 이름: 낭독기 aria-valuetext로도 읽힌다 (사용자 11/23: 31%에서 멈춘 듯 보임) */
export function Bar({ label, value, danger, text }: { label: string; value: number; danger?: boolean; text?: string }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div className="bar-wrap">
      <span className="note">{label} · <span className="num">{pct}</span>%{text && <> · 지금: {text}</>}</span>
      <div className={`bar${danger ? ' danger' : ''}`} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-valuetext={text ? `${pct}%, ${text}` : undefined}><span style={{ width: `${pct}%` }} /></div>
    </div>
  );
}
