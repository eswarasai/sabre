#!/usr/bin/env node

const solc = require('solc');
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const ora = require('ora');
const requireFromString = require('require-from-string');
const Profiler = require('truffle-compile/profiler');
const Resolver = require('truffle-resolver');
const client = require('./lib/client');
const compiler = require('./lib/compiler');
const report = require('./lib/report');
const releases = require('./lib/releases');
const util = require('util');

let ethAddress = process.env.MYTHX_ETH_ADDRESS;
let password = process.env.MYTHX_PASSWORD;
let apiUrl = process.env.MYTHX_API_URL;

const args = require('minimist')(process.argv.slice(2), {
    boolean: [ 'version', 'help', 'noCacheLookup', 'debug' ],
    string: [ 'mode', 'format' ],
    default: { mode: 'quick', format: 'text' },
});

const helpText = `Minimum viable CLI for the MythX security analysis platform.

USAGE:

$ sabre [options] <solidity_file> [contract_name]

OPTIONS:
    --version                                       Print version
    --help                                          Print help message
    --mode <quick/full>                             Analysis mode (default=quick)
    --format <text/stylish/compact/table/html/json> Output format (default=text)
    --clientToolName <string>                       Override clientToolName
    --noCacheLookup                                 Deactivate MythX cache lookups
    --debug                                         Print MythX API request and response
`;

if (args.version) {
    const { version } = require('./package.json');

    console.log(version);

    process.exit(0);
}

if (!args._.length || args.help) {
    console.log(helpText);

    process.exit(0);
}

if (!['quick', 'full'].includes(args.mode)) {
    console.log('Invalid analysis mode. Please use either "quick" or "full".');

    process.exit(-1);
}

if (['stylish', 'compact', 'table', 'html', 'json', 'text'].indexOf(args.format) < 0) {
    console.log('Invalid output format. Please use "stylish", "compact", "table", "html" or "json".');

    process.exit(-1);
}

const solidityFilePath = path.resolve(process.cwd(), args._[0]);
const solidityFileDir = path.dirname(solidityFilePath);

if (!(ethAddress && password)) {
    ethAddress = '0x0000000000000000000000000000000000000000';
    password = 'trial';
}

let solidityCode;

try {
    solidityCode = fs.readFileSync(solidityFilePath, 'utf8');
} catch (err) {
    console.log('Error opening input file ' + err.message);

    process.exit(-1);
}

const resolver = new Resolver({
    working_directory: solidityFileDir,
    contracts_build_directory: solidityFileDir
});

const allSources = {};

/* Get the version of the Solidity Compiler */

const version = compiler.getSolidityVersion(solidityCode);

const solcSpinner = ora({ text: `Downloading solc v${version}`, color: 'yellow', spinner: 'bouncingBar' }).start();

try {
    compiler.loadSolcVersion(releases[version], (solcString) => {
        /* NOTE: `solcSnapshot` has the same interface as `solc` */
        const solcSnapshot = solc.setupMethods(requireFromString(solcString), 'soljson-' + releases[version] + '.js');

        /* Parse all the import sources and the `sourceList` */
        Profiler.resolveAllSources(resolver, [solidityFilePath], solcSnapshot)
            .then(resolved => {
                const sourceList = Object.keys(resolved);

                sourceList.forEach(file => {
                    allSources[file] = { content: resolved[file].body };
                });

                /* Get the input config for the Solidity Compiler */
                const input = compiler.getSolcInput(allSources);

                let compiledData;

                try {
                    compiledData = compiler.getCompiledContracts(input, solcSnapshot, solidityFilePath, args._[1]);
                } catch (e) {
                    console.log(chalk.red(e.message));

                    process.exit(1);
                }

                solcSpinner.succeed(`Compiled with solc v${version} successfully`);

                const data = client.getRequestData(
                    compiledData,
                    sourceList,
                    solidityFilePath,
                    args
                );

                let initialDelay;
                let timeout;

                if (args.mode == "quick") {
                    initialDelay = 20 * 1000;
                    timeout = 180 * 1000;
                } else {
                    initialDelay = 300 * 1000;
                    timeout = 2400 * 1000;
                }

                if (args.debug) {
                    console.log('-------------------');
                    console.log('MythX Request Body:\n');
                    console.log(util.inspect(data, false, null, true /* enable colors */));
                }

                const analysisSpinner = ora({ text: 'Analyzing ' + compiledData.contractName, color: 'yellow', spinner: 'bouncingBar' }).start();

                client.getMythXReport(apiUrl, ethAddress, password, data, initialDelay, timeout)
                    .then(result => {
                        /* Stop the spinner and clear from the terminal */
                        analysisSpinner.stop();

                        /* Add all the imported contracts source code to the `data` to sourcemap the issue location */
                        data.sources = { ...input.sources };

                        if (args.debug) {
                            console.log('-------------------');
                            console.log('MythX Response Body:\n');
                            console.log(util.inspect(result, { showHidden: false, depth: null }));
                            console.log('-------------------');
                        }

                        const { issues } = result;
                        const uniqueIssues = report.formatIssues(data, issues);

                        if (uniqueIssues.length === 0) {
                            console.log(chalk.green(`✔ No errors/warnings found in ${args._[0]} for contract: ${compiledData.contractName}`));
                        } else {
                            const formatter = report.getFormatter(args.format);

                            console.log(formatter(uniqueIssues));
                        }
                    })
                    .catch(err => {
                        analysisSpinner.fail('Analysis failed');

                        console.log(chalk.red(err));
                    });
            })
            .catch(err => {
                solcSpinner.fail('Resolving imports failed');

                console.log(chalk.red(err));
            });
    });
} catch (err) {
    solcSpinner.fail(`Compilation with solc v${version} failed`);

    console.log(chalk.red(err.message));
}
