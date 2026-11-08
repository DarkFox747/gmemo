# Delta for Demo Kit

## ADDED Requirements

### Requirement: Demo helpers
`pnpm demo:promote -- --branch <b> [--pr <n>]` SHALL call `POST /promote` through the dev OIDC bypass (feature branch requires `--pr`) and print the outcome; `pnpm demo:reset` SHALL recreate the compose stack from scratch and wait until healthy.

#### Scenario: Promote the agent's branch
- GIVEN an agent staged items on `feature/x`
- WHEN running `pnpm demo:promote -- --branch feature/x --pr 101`
- THEN the outcome counts are printed and the web queue shows the uncertain items
