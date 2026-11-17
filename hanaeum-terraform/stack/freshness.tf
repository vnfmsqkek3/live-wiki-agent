# 최신성 점검 일 1회 (dhxorb96 freshnessSweep, 사용자 13항 2: 살아있는 위키)
resource "aws_iam_role" "freshness_scheduler" {
  count = contains(var.team_lambdas, "freshness-sweep") ? 1 : 0
  name  = "${local.n.prefix}-role-sched-freshness${local.n.suffix}"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "scheduler.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy" "freshness_scheduler" {
  count = length(aws_iam_role.freshness_scheduler)
  role  = aws_iam_role.freshness_scheduler[0].id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "lambda:InvokeFunction", Resource = module.team["freshness-sweep"].arn }]
  })
}

resource "aws_scheduler_schedule" "freshness" {
  count                        = length(aws_iam_role.freshness_scheduler)
  name                         = "${local.n.prefix}-sched-freshness${local.n.suffix}"
  schedule_expression          = "cron(0 0 * * ? *)" # 매일 00:00 KST 기준 시행일 처리
  schedule_expression_timezone = "Asia/Seoul"
  flexible_time_window { mode = "OFF" }
  target {
    arn      = module.team["freshness-sweep"].arn
    role_arn = aws_iam_role.freshness_scheduler[0].arn
    input    = jsonencode({ source = "scheduler" })
  }
}
