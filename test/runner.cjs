const path = require('node:path');
const Mocha = require('mocha');

exports.run = function run() {
	const mocha = new Mocha({ ui: 'tdd', timeout: 60000, color: false });
	for (const file of JSON.parse(process.env.COLUMBUS_TEST_FILES)) {
		mocha.addFile(path.resolve(file));
	}
	return new Promise((resolve, reject) => {
		mocha.run(failures => (failures ? reject(new Error(`${failures} test(s) failed`)) : resolve()));
	});
};
