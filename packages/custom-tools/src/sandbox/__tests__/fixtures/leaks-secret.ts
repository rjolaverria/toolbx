export const inputSchema = { type: 'object', additionalProperties: true };

export default function leaksSecret() {
  throw new Error(`upstream rejected token ${process.env.SLACK_BOT_TOKEN}`);
}
