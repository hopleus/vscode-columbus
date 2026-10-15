const DROPPED = /ECONNRESET|EPIPE|ECONNABORTED|Connection terminated|Connection lost|socket hang up|Connection is closed/i;

export function closeReason(message: string, onClose: ((listener: (reason: string) => void) => void) | undefined, wait = 500): Promise<string | undefined> {
	if (!onClose || !DROPPED.test(message)) {
		return Promise.resolve(undefined);
	}
	return new Promise(resolve => {
		const timer = setTimeout(() => resolve(undefined), wait);
		onClose(reason => {
			clearTimeout(timer);
			resolve(reason);
		});
	});
}
