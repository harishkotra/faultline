# SigNoz dashboard and alerts

Create the dashboard in self-hosted SigNoz with these panels:

- `sum(faultline.runs)` grouped by `outcome`.
- p95 `faultline.agent.duration_ms` grouped by `agent`.
- `sum(faultline.retries)` grouped by `agent`.
- `sum(faultline.llm.tokens)` grouped by `agent`.
- `sum(faultline.budget_breaches)` grouped by `scenario`.
- Logs filtered by `service.name = faultline-runner` and `faultline.run_id`.

Create alerts for any `faultline.budget_breaches > 0` in five minutes and any error span from `faultline-runner` in five minutes. Faultline links operators directly to the native dashboard and alert pages rather than duplicating those interfaces.
