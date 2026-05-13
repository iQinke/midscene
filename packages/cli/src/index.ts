import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createReportCliCommands } from '@midscene/core';
import { runToolsCLI } from '@midscene/shared/cli';
import type { BaseMidsceneTools } from '@midscene/shared/mcp/base-tools';
import dotenv from 'dotenv';
import pkg from '../package.json' with { type: 'json' };
import { BatchRunner } from './batch-runner';
import { BatchRunnerVscex } from './batch-runner-vscex';
import { matchYamlFiles, parseProcessArgs } from './cli-utils';
import { createConfig, createFilesConfig } from './config-factory';

export { BatchRunnerVscex } from './batch-runner-vscex';
export type { BatchRunnerConfig } from './batch-runner';
export type { JsonMessage } from './batch-runner-vscex';

Promise.resolve(
  (async () => {
    const rawArgs = process.argv.slice(2);
    const [firstArg] = rawArgs;
    if (firstArg === 'report-tool') {
      await runToolsCLI(
        {
          initTools: async () => undefined,
          destroy: async () => undefined,
          getToolDefinitions: () => [],
        } as unknown as BaseMidsceneTools,
        'midscene',
        {
          argv: rawArgs,
          version: pkg.version,
          extraCommands: createReportCliCommands(),
        },
      );
      return;
    }

    const { options, path, files: cmdFiles } = await parseProcessArgs();
    // 👇 3. 关键：提取 json-stream 标志
    // 注意：yargs 会将 kebab-case 转换为 camelCase，或者直接用字符串索引
    const isJsonStream = options['json-stream'] === true;

    const welcome = `\nWelcome to @midscene/cli v${pkg.version}\n`;
    //console.log(welcome);

    if (options.url) {
      console.error(
        'the cli mode is no longer supported, please use yaml file instead. See https://midscenejs.com/automate-with-scripts-in-yaml for more information. Sorry for the inconvenience.',
      );
      process.exit(1);
    }

    const configFile = options.config as string | undefined;

    if (!configFile && !path && !(cmdFiles && cmdFiles.length > 0)) {
      console.error('No script path, files, or config provided');
      process.exit(1);
    }

    // Extract new configuration options
    const configOptions = {
      concurrent: options.concurrent,
      continueOnError: options['continue-on-error'],
      summary: options.summary,
      shareBrowserContext: options['share-browser-context'],
      headed: options.headed,
      keepWindow: options['keep-window'],
      dotenvOverride: options['dotenv-override'],
      dotenvDebug: options['dotenv-debug'],
      web: options.web,
      android: options.android,
      ios: options.ios,
      files: cmdFiles,
    };

    let config;

    if (configFile) {
      config = await createConfig(configFile, configOptions);
      console.log(`Config file: ${configFile}`);
    } else if (cmdFiles && cmdFiles.length > 0) {
      console.log('Executing YAML files from --files argument...');
      config = await createFilesConfig(cmdFiles, configOptions);
    } else if (path) {
      const files = await matchYamlFiles(path);
      if (files.length === 0) {
        console.error(`No yaml files found in ${path}`);
        process.exit(1);
      }
      console.log('Executing YAML files...');
      config = await createFilesConfig(files, configOptions);
    }

    if (!config) {
      console.error('Could not create a valid configuration.');
      process.exit(1);
    }

    const dotEnvConfigFile = join(process.cwd(), '.env');
    if (existsSync(dotEnvConfigFile)) {
      console.log(`Env file: ${dotEnvConfigFile}`);
      dotenv.config({
        path: dotEnvConfigFile,
        debug: config.dotenvDebug,
        override: config.dotenvOverride,
      });
    }

    // 核心分发逻辑：在这里决定使用哪个 Runner
    let executor;
    if (isJsonStream) {
      // 使用专门为插件设计的 Runner
      executor = new BatchRunnerVscex(config);
    } else {
      // 原有逻辑：使用 TTY 终端渲染器
      executor = new BatchRunner(config);
    }

    await executor.run();

    const success = executor.printExecutionSummary();
    if (!success) {
      process.exit(1);
    }
    process.exit(0);
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  }),
);
