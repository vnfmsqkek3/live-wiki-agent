# 업무 분류 주기 정리 일 1회 (사용자 결정 11/17 "A: 완전 자동", 계약 interfaces.md 10.1)
resource "aws_iam_role" "category_scheduler" {
  count = contains(var.team_lambdas, "category-sweep") ? 1 : 0
  name  = "${local.n.prefix}-role-sched-category${local.n.suffix}"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "scheduler.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy" "category_scheduler" {
  count = length(aws_iam_role.category_scheduler)
  role  = aws_iam_role.category_scheduler[0].id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "lambda:InvokeFunction", Resource = module.team["category-sweep"].arn }]
  })
}

resource "aws_scheduler_schedule" "category" {
  count                        = length(aws_iam_role.category_scheduler)
  name                         = "${local.n.prefix}-sched-category${local.n.suffix}"
  schedule_expression          = "cron(0 3 * * ? *)" # 매일 03:00 KST (업무 시간 밖)
  schedule_expression_timezone = "Asia/Seoul"
  flexible_time_window { mode = "OFF" }
  target {
    arn      = module.team["category-sweep"].arn
    role_arn = aws_iam_role.category_scheduler[0].arn
    input    = jsonencode({ source = "scheduler" })
  }
}
