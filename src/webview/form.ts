import '@vscode-elements/elements/dist/vscode-button/index.js';
import '@vscode-elements/elements/dist/vscode-checkbox/index.js';
import '@vscode-elements/elements/dist/vscode-form-group/index.js';
import '@vscode-elements/elements/dist/vscode-label/index.js';
import '@vscode-elements/elements/dist/vscode-option/index.js';
import '@vscode-elements/elements/dist/vscode-progress-ring/index.js';
import '@vscode-elements/elements/dist/vscode-single-select/index.js';
import '@vscode-elements/elements/dist/vscode-textfield/index.js';
import type { VscodeButton, VscodeCheckbox, VscodeSingleSelect, VscodeTextfield } from '@vscode-elements/elements';
import { DRIVERS, formatUrl, parseUrl } from '../drivers/connection';
import type { ConnectionConfig, DriverKind, RedisMode, SshAuth, SslMode } from '../drivers/connection';
import type { DriverInfo, FormHostMessage, FormViewMessage, Secrets, SourceFields, SslFileField } from '../shared/form-protocol';

declare function acquireVsCodeApi(): { postMessage(message: FormViewMessage): void };

const vscode = acquireVsCodeApi();
const SSL_MODES: [SslMode, string][] = [['disable', 'Disable'], ['require', 'Require'], ['verify-ca', 'Verify CA'], ['verify-full', 'Verify CA and host']];
const MODES: [string, string][] = [['standalone', 'Standalone'], ['cluster', 'Cluster'], ['sentinel', 'Sentinel']];
const SSH_AUTH: [SshAuth, string][] = [['password', 'Password'], ['key', 'Key pair'], ['agent', 'OpenSSH agent']];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	node.className = className;
	node.textContent = text;
	return node;
}

function textfield(id: string, type: 'text' | 'password' | 'number' = 'text'): VscodeTextfield {
	const field = document.createElement('vscode-textfield') as VscodeTextfield;
	field.id = id;
	field.type = type;
	return field;
}

function select(id: string, options: [string, string][]): VscodeSingleSelect {
	const field = document.createElement('vscode-single-select') as VscodeSingleSelect;
	field.id = id;
	for (const [value, label] of options) {
		const option = document.createElement('vscode-option');
		option.setAttribute('value', value);
		option.textContent = label;
		field.append(option);
	}
	return field;
}

function button(text: string, secondary = false): VscodeButton {
	const node = document.createElement('vscode-button') as VscodeButton;
	node.textContent = text;
	node.secondary = secondary;
	return node;
}

function row(label: string, control: HTMLElement): HTMLElement {
	const group = document.createElement('vscode-form-group');
	group.setAttribute('variant', 'horizontal');
	const caption = document.createElement('vscode-label');
	caption.setAttribute('for', control.id || control.firstElementChild?.id || '');
	caption.textContent = label;
	group.append(caption, control);
	return group;
}

const name = textfield('name');
const driver = select('driver', (Object.keys(DRIVERS) as DriverKind[]).map(kind => [kind, DRIVERS[kind].label]));
const host = textfield('host');
const port = textfield('port', 'number');
port.className = 'port';
const user = textfield('user');
const password = textfield('password', 'password');
const database = textfield('database');
const mode = select('mode', MODES);
const master = textfield('master');
master.placeholder = 'mymaster';
const ssl = select('ssl', SSL_MODES);
const url = textfield('url');
url.spellcheck = false;
const file = textfield('file');
file.spellcheck = false;
file.placeholder = 'Path to the database file';
const browse = button('…', true);
browse.title = 'Choose a database file';
browse.className = 'browse';
const create = button('+', true);
create.title = 'Create a new database file';
create.className = 'browse';

const sslFiles: [SslFileField, VscodeTextfield, HTMLElement][] = ([['sslCa', 'ssl-ca', 'CA file:', 'Certificate authorities that sign the server certificate'], ['sslCert', 'ssl-cert', 'Client certificate:', 'Certificate the client signs in with'], ['sslKey', 'ssl-key', 'Client key:', 'Private key of the client certificate']] as const).map(([key, id, label, hint]) => {
	const field = textfield(id);
	field.spellcheck = false;
	field.placeholder = hint;
	const pick = button('…', true);
	pick.title = `Choose the ${label.slice(0, -1).toLowerCase()}`;
	pick.className = 'browse';
	pick.addEventListener('click', () => {
		const sibling = sslFiles.map(([, other]) => other.value.trim()).find(Boolean) ?? '';
		vscode.postMessage({ type: 'browseSslFile', field: key, path: field.value.trim() || sibling.slice(0, Math.max(sibling.lastIndexOf('/'), sibling.lastIndexOf('\\')) + 1) });
	});
	const picker = el('div', 'pair');
	picker.append(field, pick);
	return [key, field, row(label, picker)];
});

const sslPassphrase = textfield('ssl-passphrase', 'password');
const sslPassphraseRow = row('Key passphrase:', sslPassphrase);

const hostPort = el('div', 'pair');
hostPort.append(host, el('span', 'pair-label', 'Port:'), port);
const filePicker = el('div', 'pair');
filePicker.append(file, browse, create);

const status = el('div', 'status');
const test = button('Test Connection', true);
const force = button('Save Anyway', true);
force.hidden = true;
const cancel = button('Cancel', true);
const ok = button('OK');
const actions = el('div', 'actions');
const buttons = el('div', 'buttons');
buttons.append(force, cancel, ok);
actions.append(test, buttons);

const driverInfo = el('div', 'driver-info');
const general = el('section', 'section');
general.append(row('Name:', name), row('Driver:', driver), driverInfo);
const connection = el('section', 'section');
const modeRow = row('Mode:', mode);
const masterRow = row('Master:', master);
const databaseRow = row('Database:', database);
const serverRows = [modeRow, row('Host:', hostPort), masterRow, row('User:', user), row('Password:', password), databaseRow, row('SSL:', ssl), ...sslFiles.map(([, , fileRow]) => fileRow), sslPassphraseRow];
const fileRow = row('File:', filePicker);
connection.append(fileRow, ...serverRows, row('URL:', url));
const useSsh = document.createElement('vscode-checkbox') as VscodeCheckbox;
useSsh.id = 'use-ssh';
useSsh.label = 'Use SSH tunnel';
const sshHost = textfield('ssh-host');
sshHost.spellcheck = false;
const sshPort = textfield('ssh-port', 'number');
sshPort.className = 'port';
const sshUser = textfield('ssh-user');
const sshAuth = select('ssh-auth', SSH_AUTH);
const sshPassword = textfield('ssh-password', 'password');
const keyFile = textfield('ssh-key');
keyFile.spellcheck = false;
keyFile.placeholder = '~/.ssh/id_ed25519';
const browseKey = button('…', true);
browseKey.title = 'Choose a private key file';
browseKey.className = 'browse';
const sshHostPort = el('div', 'pair');
sshHostPort.append(sshHost, el('span', 'pair-label', 'Port:'), sshPort);
const keyPicker = el('div', 'pair');
keyPicker.append(keyFile, browseKey);
const sshPasswordRow = row('Password:', sshPassword);
const keyRow = row('Key file:', keyPicker);
const sshRows = [row('Host:', sshHostPort), row('User:', sshUser), row('Auth type:', sshAuth), keyRow, sshPasswordRow];
const sshSection = el('section', 'section');
sshSection.append(row('SSH:', useSsh), ...sshRows);
const page = el('main', 'page');
const title = el('h1', '', 'New Data Source');
page.append(title, general, connection, sshSection, actions, status);
document.getElementById('app')?.append(page);

const transparentInput = new CSSStyleSheet();
transparentInput.replaceSync(`input { background-color: transparent; }
input::-webkit-outer-spin-button, input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
input[type=number] { appearance: textfield; }`);
for (const field of [name, host, port, user, password, database, url, file, master, sshHost, sshPort, sshUser, sshPassword, keyFile, sslPassphrase, ...sslFiles.map(([, field]) => field)]) {
	const root = field.shadowRoot;
	if (root) {
		root.adoptedStyleSheets = [...root.adoptedStyleSheets, transparentInput];
	}
}

let nameTouched = false;
let passwordTouched = false;
let sshPasswordTouched = false;
let sslPassphraseTouched = false;
let busy = false;
let nextId = 0;

function kind(): DriverKind {
	return driver.value as DriverKind;
}

function megabytes(size: number): string {
	return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function link(text: string, run: () => void): HTMLAnchorElement {
	const anchor = el('a', 'driver-link', text);
	anchor.href = '#';
	anchor.addEventListener('click', e => {
		e.preventDefault();
		run();
	});
	return anchor;
}

function renderDriver(info: DriverInfo): void {
	driverInfo.className = `driver-info ${info.status}`;
	driverInfo.replaceChildren();
	const download = (): void => vscode.postMessage({ type: 'downloadDriver', kind: info.kind });
	switch (info.status) {
		case 'ready':
			driverInfo.append(`${info.library} ${info.version}`);
			return;
		case 'outdated':
			driverInfo.append(`Driver files need an update: ${info.library} ${info.previousVersion ?? ''} → ${info.version} (${megabytes(info.size)})`, link('Update', download));
			return;
		case 'missing':
			driverInfo.append(`Driver files are missing (${megabytes(info.size)})`, link('Download', download));
			return;
		case 'downloading':
			driverInfo.append(document.createElement('vscode-progress-ring'), `Downloading ${info.library} ${info.version}…`);
			return;
		case 'failed':
			driverInfo.append(info.error ?? 'Could not download the driver files', link('Retry', download));
			return;
	}
}

function isFile(): boolean {
	return kind() === 'sqlite';
}

function showRows(): void {
	fileRow.hidden = !isFile();
	for (const row of serverRows) {
		row.hidden = isFile();
	}
	modeRow.hidden = isFile() || kind() !== 'redis';
	masterRow.hidden = isFile() || kind() !== 'redis' || mode.value !== 'sentinel';
	databaseRow.hidden = isFile() || (kind() === 'redis' && mode.value === 'cluster');
	for (const [, , fileRow] of sslFiles) {
		fileRow.hidden = isFile() || ssl.value === 'disable';
	}
	sslPassphraseRow.hidden = isFile() || ssl.value === 'disable' || !sslFiles.find(([key]) => key === 'sslKey')?.[1].value.trim();
	sshSection.hidden = isFile();
	for (const row of sshRows) {
		row.hidden = !useSsh.checked;
	}
	keyRow.hidden = !useSsh.checked || sshAuth.value !== 'key';
	sshPasswordRow.hidden = !useSsh.checked || sshAuth.value === 'agent';
	const caption = sshPasswordRow.querySelector('vscode-label');
	if (caption) {
		caption.textContent = sshAuth.value === 'key' ? 'Passphrase:' : 'Password:';
	}
}

function connectionFields(): Omit<ConnectionConfig, 'password'> {
	if (isFile()) {
		return { driver: kind(), host: '', port: 0, database: file.value.trim(), user: '', ssl: 'disable' };
	}
	const redisMode = kind() === 'redis' && mode.value !== 'standalone' ? mode.value as RedisMode : undefined;
	return {
		...(redisMode ? { mode: redisMode } : {}),
		...(redisMode === 'sentinel' ? { master: master.value.trim() } : {}),
		driver: kind(),
		host: host.value.trim(),
		port: Number(port.value),
		database: database.value.trim(),
		user: user.value,
		ssl: ssl.value as SslMode,
		...(ssl.value === 'disable' ? {} : Object.fromEntries(sslFiles.filter(([, field]) => field.value.trim()).map(([key, field]) => [key, field.value.trim()]))),
	};
}

function fields(): SourceFields {
	const ssh = !isFile() && useSsh.checked
		? { host: sshHost.value.trim(), port: Number(sshPort.value), user: sshUser.value.trim(), auth: sshAuth.value as SshAuth, ...(sshAuth.value === 'key' ? { keyFile: keyFile.value.trim() } : {}) }
		: undefined;
	return { name: name.value, ...connectionFields(), ...(ssh ? { ssh } : {}) };
}

function suggestedName(): string {
	const config = connectionFields();
	if (isFile()) {
		return config.database.split(/[\\/]/).pop() ?? '';
	}
	if (config.driver === 'redis') {
		return config.mode === 'sentinel' && config.master ? `${config.master}@${config.host}` : config.host;
	}
	return config.database ? `${config.database}@${config.host}` : config.host;
}

function syncUrl(): void {
	const config = connectionFields();
	url.value = (isFile() ? config.database : config.host) ? formatUrl(config) : '';
	url.invalid = false;
	if (!nameTouched) {
		name.value = suggestedName();
	}
}

function syncFields(): void {
	const scheme = /^[a-z][a-z0-9+.-]*:/i.exec(url.value.trim())?.[0].toLowerCase();
	const target = (Object.keys(DRIVERS) as DriverKind[]).find(k => DRIVERS[k].schemes.includes(scheme ?? '')) ?? kind();
	try {
		const config = parseUrl(target, url.value);
		const changed = config.driver !== kind();
		driver.value = config.driver;
		if (changed) {
			previousDriver = config.driver;
			vscode.postMessage({ type: 'driverState', kind: config.driver });
		}
		mode.value = config.mode ?? 'standalone';
		master.value = config.master ?? '';
		showRows();
		if (config.driver === 'sqlite') {
			file.value = config.database;
			url.invalid = false;
			if (!nameTouched) {
				name.value = suggestedName();
			}
			return;
		}
		host.value = config.host;
		port.value = String(config.port);
		user.value = config.user;
		database.value = config.database;
		ssl.value = config.ssl;
		for (const [key, field] of sslFiles) {
			if (config[key]) {
				field.value = config[key];
			}
		}
		showRows();
		if (config.password) {
			password.value = config.password;
			passwordTouched = true;
		}
		url.invalid = false;
		if (!nameTouched) {
			name.value = suggestedName();
		}
	} catch {
		url.invalid = true;
	}
}

function stopTest(): void {
	if (busy) {
		showStatus('busy', 'Cancelling…', false);
		vscode.postMessage({ type: 'stop' });
	}
}

function showStatus(state: 'idle' | 'busy' | 'ok' | 'error', text = '', stoppable = true): void {
	status.className = `status ${state}`;
	status.replaceChildren();
	if (state === 'busy') {
		status.append(document.createElement('vscode-progress-ring'));
	}
	status.append(text);
	if (state === 'busy' && stoppable) {
		const stop = el('a', 'status-stop', 'Stop');
		stop.href = '#';
		stop.title = 'Stop the connection test (Escape)';
		stop.addEventListener('click', e => {
			e.preventDefault();
			stopTest();
		});
		status.append(stop);
	}
}

function setBusy(value: boolean): void {
	busy = value;
	test.disabled = value;
	ok.disabled = value;
	force.disabled = value;
}

function send(type: 'test' | 'save', forced = false): void {
	if (busy) {
		return;
	}
	const secrets: Secrets = {
		...(passwordTouched ? { password: password.value } : {}),
		...(sshPasswordTouched ? { sshPassword: sshPassword.value } : {}),
		...(sslPassphraseTouched ? { sslPassphrase: sslPassphrase.value } : {}),
	};
	force.hidden = true;
	setBusy(true);
	if (type === 'test' || !forced) {
		showStatus('busy', 'Connecting…');
	}
	if (type === 'test') {
		vscode.postMessage({ type: 'test', requestId: ++nextId, fields: fields(), secrets });
	} else {
		vscode.postMessage({ type: 'save', fields: fields(), secrets, force: forced });
	}
}

let previousDriver: DriverKind = 'postgres';
driver.addEventListener('change', () => {
	if (Number(port.value) === DRIVERS[previousDriver].port) {
		port.value = String(DRIVERS[kind()].port);
	}
	previousDriver = kind();
	showRows();
	syncUrl();
	vscode.postMessage({ type: 'driverState', kind: kind() });
});
for (const field of [host, port, user, database, file, master]) {
	field.addEventListener('input', syncUrl);
}
mode.addEventListener('change', () => {
	if (mode.value === 'sentinel' && port.value === '6379') {
		port.value = '26379';
	} else if (mode.value !== 'sentinel' && port.value === '26379') {
		port.value = '6379';
	}
	showRows();
	syncUrl();
	connectionChanged();
});
browse.addEventListener('click', () => vscode.postMessage({ type: 'browse', path: file.value }));
browseKey.addEventListener('click', () => vscode.postMessage({ type: 'browseKey', path: keyFile.value }));
useSsh.addEventListener('change', () => {
	showRows();
	connectionChanged();
	if (useSsh.checked && !sshHost.value.trim()) {
		sshHost.value = host.value.trim();
		sshUser.value = sshUser.value || user.value;
	}
});
sshAuth.addEventListener('change', () => {
	showRows();
	connectionChanged();
});
sshPassword.addEventListener('input', () => {
	sshPasswordTouched = true;
});
for (const field of [sshHost, sshPort, sshUser, sshPassword, keyFile]) {
	field.addEventListener('input', () => connectionChanged());
}
create.addEventListener('click', () => vscode.postMessage({ type: 'createFile', path: file.value }));
const connectionChanged = (): void => {
	force.hidden = true;
	if (!busy) {
		showStatus('idle');
	}
};
for (const field of [host, port, user, password, database, url, file]) {
	field.addEventListener('input', connectionChanged);
}
for (const field of [driver, ssl]) {
	field.addEventListener('change', connectionChanged);
}
ssl.addEventListener('change', () => {
	showRows();
	syncUrl();
});
for (const [, field] of sslFiles) {
	field.addEventListener('input', () => {
		connectionChanged();
		showRows();
		syncUrl();
	});
}
sslPassphrase.addEventListener('input', () => {
	sslPassphraseTouched = true;
	connectionChanged();
});
url.addEventListener('input', syncFields);
name.addEventListener('input', () => {
	nameTouched = name.value !== suggestedName();
});
password.addEventListener('input', () => {
	passwordTouched = true;
});
test.addEventListener('click', () => send('test'));
ok.addEventListener('click', () => send('save'));
force.addEventListener('click', () => send('save', true));
cancel.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
document.addEventListener('keydown', e => {
	if (e.key === 'Escape' && busy) {
		e.preventDefault();
		stopTest();
		return;
	}
	if (e.key === 'Enter' && !(e.target as HTMLElement).closest('vscode-single-select, vscode-button')) {
		e.preventDefault();
		send('save');
	}
});

window.addEventListener('message', (event: MessageEvent<FormHostMessage>) => {
	const message = event.data;
	switch (message.type) {
		case 'init': {
			const source = message.source;
			title.textContent = source ? source.name : 'New Data Source';
			driver.value = source?.driver ?? 'postgres';
			previousDriver = kind();
			host.value = source?.host ?? 'localhost';
			port.value = String(source?.port ?? DRIVERS[kind()].port);
			user.value = source?.user ?? '';
			database.value = source?.driver === 'sqlite' ? '' : source?.database ?? '';
			file.value = source?.driver === 'sqlite' ? source.database : '';
			mode.value = source?.mode ?? 'standalone';
			master.value = source?.master ?? '';
			useSsh.checked = !!source?.ssh;
			sshHost.value = source?.ssh?.host ?? '';
			sshPort.value = String(source?.ssh?.port ?? 22);
			sshUser.value = source?.ssh?.user ?? '';
			sshAuth.value = source?.ssh?.auth ?? 'password';
			keyFile.value = source?.ssh?.keyFile ?? '';
			sshPassword.placeholder = message.hasSshPassword ? '<hidden>' : '';
			sslPassphrase.placeholder = message.hasSslPassphrase ? '<hidden>' : '';
			ssl.value = source?.ssl ?? 'disable';
			for (const [key, field] of sslFiles) {
				field.value = source?.[key] ?? '';
			}
			showRows();
			password.placeholder = message.hasPassword ? '<hidden>' : '';
			name.value = source?.name ?? '';
			nameTouched = !!source && source.name !== suggestedName();
			syncUrl();
			name.focus();
			return;
		}
		case 'driver':
			if (message.driver.kind === kind()) {
				renderDriver(message.driver);
			}
			return;
		case 'tested':
			if (message.requestId === nextId) {
				setBusy(false);
				showStatus(message.ok ? 'ok' : 'error', message.ok ? `Succeeded · ${message.message}` : message.message);
			}
			return;
		case 'failed':
			setBusy(false);
			showStatus('error', message.message);
			force.hidden = !message.canForce;
			return;
		case 'keyFile':
			keyFile.value = message.path;
			connectionChanged();
			return;
		case 'sslFile':
			for (const [key, field] of sslFiles) {
				if (key === message.field) {
					field.value = message.path;
				}
			}
			connectionChanged();
			showRows();
			syncUrl();
			return;
		case 'file':
			file.value = message.path;
			connectionChanged();
			syncUrl();
			return;
	}
});

showRows();
showStatus('idle');
vscode.postMessage({ type: 'ready' });
