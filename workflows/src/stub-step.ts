// 단계 Owner 의 Lambda 가 배포되기 전까지 쓰는 dev 전용 stub (mock). 현재 graph_upsert(Neptune 전)가 사용.
// 파이프라인 Gateway Tool 로 호출되며 { status: "OK" } 만 돌려준다.
export const handler = async () => ({ status: "OK" as const });
