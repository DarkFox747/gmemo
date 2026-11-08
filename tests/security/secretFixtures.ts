/** Synthetic secret fixtures per category (C3 span-redaction tests). Never real credentials. */
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
];
