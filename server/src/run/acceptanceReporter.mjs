/** Only Node test-runner events can attest checks; candidate stdout is retained as data. */
export default async function* report(events) {
  for await (const event of events) {
    const data = event.data;
    if (['test:pass', 'test:fail', 'test:diagnostic', 'test:stderr', 'test:stdout'].includes(event.type)) {
      yield JSON.stringify({ type: event.type, name: data.name, file: data.file, message: data.message,
        error: data.details?.error ? String(data.details.error) : undefined }) + '\n';
    }
  }
}
