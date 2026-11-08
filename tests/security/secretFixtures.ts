/** Synthetic secret fixtures per category (C3 span-redaction tests). Never real credentials. */

// Newer credential shapes are assembled at runtime so no literal token ever sits in the
// repo (the package sanitize gate and GitHub push protection scan committed text).
const ALNUM_22 = ['AbCdEfGhIj', 'KlMnOpQrSt', '01'].join('');

/** OpenAI project-key shape: sk-proj- + token with inner `_`/`-`. */
export const OPENAI_PROJECT_KEY = ['sk', 'proj', `${ALNUM_22}_T3BlbkFJ-${ALNUM_22}`].join('-');

/** Anthropic-style key shape: sk-ant- + kind/version segment + token with inner `_`/`-`. */
export const ANTHROPIC_STYLE_KEY = ['sk', 'ant', 'api03', `${ALNUM_22}_${ALNUM_22}-AbCd`].join('-');

/** Builds another kind-prefixed sk- key shape (sk-<kind>-<token>) at runtime. */
export const skKindKey = (kind: string): string =>
  ['sk', kind, `${ALNUM_22}_${ALNUM_22}`].join('-');

/** GitHub fine-grained PAT shape: github_pat_ + 22 alnum + `_` + 59 alnum. */
export const GITHUB_FINE_GRAINED_PAT = ['github', 'pat', ALNUM_22, 'x'.repeat(59)].join('_');

/** AWS secret access key shape: exactly 40 base64 characters (incl. `/` and `+`). */
export const AWS_SECRET_VALUE = ['Zq8Lm2Pn5R', 't7Vx9/Bc4D', 'f6Hj1Kw3Ys', '0+Ua8Ge5Ti'].join('');

/** AWS access key id shape (AKIA + 16 uppercase alnum), assembled at runtime. */
export const AWS_ACCESS_KEY_ID = ['AKIA', 'FIXTURE7Q3K9ZX2W'].join('');

export const SECRET_FIXTURES: ReadonlyArray<{ category: string; text: string; secret: string }> = [
  {
    category: 'aws_access_key_id',
    secret: 'AKIAIOSFODNN7EXAMPLE',
    text: 'Deploy used AKIAIOSFODNN7EXAMPLE in CI.',
  },
  {
    category: 'pem_private_key',
    secret: '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEAzQ7v\n-----END RSA PRIVATE KEY-----',
    text: 'Key below:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEAzQ7v\n-----END RSA PRIVATE KEY-----\nrotate it.',
  },
  {
    category: 'jwt',
    secret: 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyMTIzIn0.c2lnbmF0dXJl',
    text: 'Header eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyMTIzIn0.c2lnbmF0dXJl was logged.',
  },
  {
    category: 'github_token',
    secret: 'ghp_1234567890abcdefghij',
    text: 'Use ghp_1234567890abcdefghij for the bot.',
  },
  {
    category: 'slack_token',
    secret: 'xoxb-my-slack-bot-token',
    text: 'Bot token: xoxb-my-slack-bot-token here.',
  },
  {
    category: 'google_api_key',
    secret: 'AIzaSyDdI0hCZtE6vySjMm-WEfRq3CPzqKqqsHI',
    text: 'Maps key AIzaSyDdI0hCZtE6vySjMm-WEfRq3CPzqKqqsHI leaked.',
  },
  {
    category: 'stripe_secret_key',
    secret: 'sk_live_testkey123',
    text: 'Billing used sk_live_testkey123 today.',
  },
  {
    category: 'openai_api_key',
    secret: 'sk-abcdefghijklmnopqrstuv',
    text: 'Model key sk-abcdefghijklmnopqrstuv in env.',
  },
  {
    category: 'secret_assignment',
    secret: 'hunter2hunter2hunter2',
    text: 'Set password=hunter2hunter2hunter2 then restart.',
  },
  {
    category: 'openai_project_key',
    secret: OPENAI_PROJECT_KEY,
    text: `Project key ${OPENAI_PROJECT_KEY} in env.`,
  },
  {
    category: 'github_fine_grained_pat',
    secret: GITHUB_FINE_GRAINED_PAT,
    text: `CI used ${GITHUB_FINE_GRAINED_PAT} for the release.`,
  },
  {
    category: 'aws_secret_access_key',
    secret: AWS_SECRET_VALUE,
    text: `Set aws_secret_access_key = ${AWS_SECRET_VALUE} then deploy.`,
  },
];
