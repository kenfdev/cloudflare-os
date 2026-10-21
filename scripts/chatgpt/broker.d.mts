/** Starts the trusted local ChatGPT broker, without initiating sign-in. */
export function startBroker(options: {
  secret: string;
  port?: number;
}): Promise<{ url: string; close(): Promise<void> }>;
