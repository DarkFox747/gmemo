# Delta for auth

## ADDED Requirements

### Requirement: Project-admin authorization and user identity

Gate 2 SHALL expose a project-admin check that succeeds only for an enabled user holding `project_admin` on the given project; every other case (other role, no membership, disabled, unknown user, platform role without membership) MUST fail with the same opaque denial. The resolved identity SHALL carry the `app_user.id` (`userId`) so reviewer and approver columns reference users, not token subjects.

#### Scenario: Only project_admin passes
- GIVEN users with roles project_admin, contributor, viewer, service_agent on project P, and a platform_admin without membership
- WHEN the project-admin check runs for P
- THEN only the project_admin passes and all others receive an identical denial

### Requirement: Development user selection

The development authenticator SHALL resolve an optional development user (by email, case-insensitive) to an existing enabled user, defaulting to the development principal when absent, and MUST refuse to construct or authenticate under `NODE_ENV=production`.

#### Scenario: Unknown dev user rejected
- GIVEN dev bypass enabled
- WHEN the requested development user email does not exist or is disabled
- THEN authentication fails
