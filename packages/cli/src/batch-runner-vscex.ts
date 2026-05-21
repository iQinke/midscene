import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import type {
  MidsceneYamlConfigResult,
  MidsceneYamlScript,
  MidsceneYamlScriptAndroidEnv,
  MidsceneYamlScriptEnv,
  MidsceneYamlScriptIOSEnv,
  MidsceneYamlScriptWebEnv,
} from '@midscene/core';
import { type ScriptPlayer, parseYamlScript } from '@midscene/core/yaml';
import { getMidsceneRunSubDir } from '@midscene/shared/common';
import {
  buildChromeArgs,
  defaultViewportHeight,
  defaultViewportWidth,
} from '@midscene/web/puppeteer-agent-launcher';

import merge from 'lodash.merge';
import pLimit from 'p-limit';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import type { BatchRunnerConfig } from './batch-runner';
import { createYamlPlayer } from './create-yaml-player';
import {
  type MidsceneYamlFileContext,
  contextInfo,
  contextTaskListSummary,
  isTTY,
  spinnerInterval,
} from './printer';

// 定义 JSON 消息的联合类型（根据你的设计文档）
export type JsonMessage =
  | {
      type: 'test:plan';
      files: string[];
      concurrent: number;
      headed: boolean;
      shareBrowserContext: boolean;
    }
  | { type: 'test:start'; file: string }
  | {
      type: 'test:step';
      file: string;
      step: string;
      status: string;
      duration?: number;
      error?: string | null;
    }
  | {
      type: 'test:action';
      file: string;
      stepIndex: number;
      stepAction: string;
      stepData: any;
    }
  | {
      type: 'test:end';
      file: string;
      status: string;
      duration: number;
      message?: string;
    }
  | { type: 'result'; file: string; resultType: string; error?: string }
  | { type: 'summary'; status: string; message?: string }
  | { type: 'error'; message: string }
  | { type: 'status'; message: string };

interface BatchFileContext {
  file: string;
  executionConfig: MidsceneYamlScript;
  outputPath?: string;
  options: {
    headed?: boolean;
    keepWindow?: boolean;
    browser?: Browser;
    page?: Page;
  };
}

class BatchRunnerVscex {
  private config: BatchRunnerConfig;
  private results: MidsceneYamlConfigResult[] = [];

  // 👇 新增：用于管理取消信号的控制器
  private abortController = new AbortController();
  // 👇 新增：标记是否正在处理关闭逻辑，防止重复执行
  private isShuttingDown = false;
  // 👇 新增：用于保存浏览器实例
  private browserInstance: Browser | null = null;

  // 👇 关键点2：消息回调注入，不再依赖 stdout
  private onMessage: (msg: JsonMessage) => void;

  constructor(
    config: BatchRunnerConfig,
    onMessage?: (msg: JsonMessage) => void,
  ) {
    this.config = config;
    // 即使插件没传 onMessage，这里也可以给一个空函数，防止报错
    this.onMessage = onMessage || (() => {});
  }

  /**
   * 统一消息发送入口
   * 负责将内部状态分发给 插件回调 或 标准输出
   */
  private sendJson(msg: JsonMessage) {
    // 1. 优先发送给插件（如果有）
    if (this.onMessage) {
      this.onMessage(msg);
    }

    // 2. 如果是纯 CLI 模式，才打印到控制台
    // 注意：在插件模式下，我们通常不希望 console.log 污染 Output Channel

    // 使用 process.stdout.write 而不是 console.log，性能更好且不换行混乱
    process.stdout.write(`${JSON.stringify(msg)}\n`);
  }

  async run(): Promise<MidsceneYamlConfigResult[]> {
    const { keepWindow, headed } = this.config;

    // --- ⭐ 新增：注册信号监听器 ⭐ ---
    const removeSignalListeners = this.setupSignalHandlers();

    // Print execution plan
    // this.printExecutionPlan();

    this.sendJson({
      type: 'test:plan',
      files: this.config.files,
      concurrent: this.config.concurrent,
      headed: this.config.headed,
      shareBrowserContext: this.config.shareBrowserContext,
    });

    // Prepare file contexts
    const fileContextList: BatchFileContext[] = [];
    const browser: Browser | null = null;
    let sharedPage: Page | null = null;

    try {
      // First, create all file contexts without a browser instance
      for (const file of this.config.files) {
        const fileConfig = await this.loadFileConfig(file);
        const context = await this.createFileContext(file, fileConfig, {
          headed,
          keepWindow,
        });
        fileContextList.push(context);
      }

      // Now, check if any of the tasks require a web browser
      const needsBrowser = fileContextList.some(
        (ctx) =>
          Object.keys(
            ctx.executionConfig.web || ctx.executionConfig.target || {},
          ).length > 0,
      );

      if (needsBrowser && this.config.shareBrowserContext) {
        const globalWebConfig = this.config.globalConfig?.web;

        if (globalWebConfig?.cdpEndpoint) {
          // CDP mode: connect to an existing browser
          this.browserInstance = await puppeteer.connect({
            browserWSEndpoint: globalWebConfig.cdpEndpoint,
            defaultViewport: null,
          });
        } else {
          // Extract viewport dimensions from global config or use defaults
          // This should match the logic in launchPuppeteerPage
          const width = globalWebConfig?.viewportWidth ?? defaultViewportWidth;
          const height =
            globalWebConfig?.viewportHeight ?? defaultViewportHeight;

          const args = buildChromeArgs({
            userAgent: globalWebConfig?.userAgent,
            // Only pass windowSize in headed mode; in headless mode, defaultViewport takes precedence
            windowSize: headed ? { width, height } : undefined,
            chromeArgs: globalWebConfig?.chromeArgs,
          });

          this.browserInstance = await puppeteer.launch({
            headless: !headed,
            defaultViewport: headed ? null : { width, height },
            args,
            acceptInsecureCerts: globalWebConfig?.acceptInsecureCerts,
          });
        }

        // Create a shared page instance that will be reused across all YAML files
        // This ensures localStorage and sessionStorage are preserved between files
        sharedPage = await this.browserInstance.newPage();

        // Assign the browser instance and shared page to all contexts
        for (const context of fileContextList) {
          context.options.browser = this.browserInstance;
          context.options.page = sharedPage;
        }
      }

      // Execute files
      const { executedResults, notExecutedContexts } =
        await this.executeFiles(fileContextList);

      // Process results
      this.results = await this.processResults(
        executedResults,
        notExecutedContexts,
      );
    } catch (err: any) {
      // 👇 关键点3：捕获取消信号，不报错，只记录
      if (err.message === 'ExecutionCancelledByUser') {
        this.sendJson({
          type: 'summary',
          status: 'cancelled',
          message: 'Execution was cancelled by user',
        });
      } else {
        // 真正的系统错误
        this.sendJson({ type: 'error', message: err.message });
      }
    } finally {
      // 关键：先标记为关闭，防止信号处理函数再次触发
      this.isShuttingDown = true;

      // 移除信号监听器，防止在清理时再次收到 SIGTERM 导致崩溃
      removeSignalListeners();

      // 执行清理（关闭浏览器）
      await this.cleanupResources();

      // 生成报告
      await this.generateOutputIndex();
    }

    return this.results;
  }

  /**
   * 信号处理：只负责标记状态和抛出异常，不负责 exit
   */
  private setupSignalHandlers(): () => void {
    const handleExitSignal = async (signal: 'SIGINT' | 'SIGTERM') => {
      if (this.isShuttingDown) return;
      this.isShuttingDown = true;

      this.sendJson({
        type: 'status',
        message: `Received ${signal}, shutting down gracefully...`,
      });

      // 标记取消
      this.abortController.abort();

      // 清理资源（浏览器等）
      await this.cleanupResources();

      // 👇 抛出异常，中断 run() 流程，让插件去处理后续
      throw new Error('ExecutionCancelledByUser');
    };

    // 绑定监听器
    process.on('SIGINT', handleExitSignal); // Ctrl+C
    process.on('SIGTERM', handleExitSignal); // 标准终止信号 (VS Code 使用这个)

    // 返回一个解绑函数
    return () => {
      process.removeListener('SIGINT', handleExitSignal);
      process.removeListener('SIGTERM', handleExitSignal);
    };
  }

  /**
   * 清理外部资源（主要是浏览器实例）
   */
  private async cleanupResources() {
    // 1. 立即移除所有信号监听器，防止递归
    // (注意：这里假设你在 setupSignalHandlers 中有相关逻辑，或者在外部处理)

    // 2. 强制关闭浏览器
    if (this.browserInstance) {
      const globalWebConfig = this.config.globalConfig?.web;
      const isCdpMode = !!globalWebConfig?.cdpEndpoint;

      try {
        // 关键：使用 close() 而不是 disconnect()，并设置超时
        if (isCdpMode) {
          // CDP 模式通常不需要关闭浏览器，只断开连接
          this.browserInstance.disconnect();
        } else {
          // 对于自己启动的浏览器，必须强制关闭
          // Puppeteer 的 close() 有时会卡住，我们给它加个 Promise 超时包装
          await Promise.race([
            this.browserInstance.close(),
            new Promise((resolve) => setTimeout(resolve, 5000)), // 5秒超时
          ]);
        }
      } catch (error) {
        console.error('Error during forced browser cleanup:', error);
        // 即使报错也继续，目的是让进程能退出
      } finally {
        this.browserInstance = null;
      }
    }
  }

  private async createFileContext(
    file: string,
    fileConfig: MidsceneYamlScript,
    options: { headed?: boolean; keepWindow?: boolean; browser?: Browser },
  ): Promise<BatchFileContext> {
    const { globalConfig } = this.config;

    // Deep clone to avoid mutation
    const clonedFileConfig = JSON.parse(JSON.stringify(fileConfig));

    // Normalize deprecated 'target' to 'web'
    if (clonedFileConfig.target) {
      clonedFileConfig.web = {
        ...clonedFileConfig.target,
        ...clonedFileConfig.web,
      };
      // biome-ignore lint/performance/noDelete: <explanation>
      delete clonedFileConfig.target;
    }
    if (globalConfig?.target) {
      globalConfig.web = { ...globalConfig.target, ...globalConfig.web };
      // biome-ignore lint/performance/noDelete: <explanation>
      delete globalConfig.target;
    }

    // Start with the file's config, then merge the global config from the index file,
    // which has already been merged with command-line options.
    const executionConfig = merge(clonedFileConfig, globalConfig);

    return {
      file,
      executionConfig,
      options,
    };
  }

  private async executeFiles(fileContextList: BatchFileContext[]) {
    const executedResults: Array<{
      file: string;
      player: ScriptPlayer<MidsceneYamlScriptEnv>;
      duration: number;
    }> = [];
    const notExecutedContexts: Array<{
      file: string;
      player: ScriptPlayer<MidsceneYamlScriptEnv> | null;
    }> = [];

    // 1. 创建并发控制器
    const limit = pLimit(this.config.concurrent);

    // 2. 遍历文件列表（按顺序，但执行受并发限制）
    for (const context of fileContextList) {
      // --- ⭐ 关键修复 1：在任务入队前检查取消信号 ⭐ ---
      // 防止在高并发队列积压时，取消信号无法立即生效
      if (this.abortController.signal.aborted) {
        notExecutedContexts.push({ file: context.file, player: null });
        this.sendJson({
          type: 'result',
          file: context.file,
          resultType: 'notExecuted',
          error: 'Cancelled',
        });
        continue; // 跳过执行
      }

      // --- ⭐ 关键修复 2：使用 async/await 包裹 limit 包装的函数 ⭐ ---
      // 这样我们可以在 await 时捕获错误，而不是被 Promise.all 捕获
      try {
        await limit(async () => {
          // --- ⭐ 关键修复 3：在任务真正开始时再次检查 ⭐ ---
          if (this.abortController.signal.aborted) {
            throw new Error('Cancelled before start');
          }

          // 记忆上一次处理的步骤名称，用于去重
          let lastProcessedStepName: string | null = null;

          this.sendJson({ type: 'test:start', file: context.file });
          const testStart = Date.now();

          let player: ScriptPlayer<MidsceneYamlScriptEnv> | undefined;

          try {
            player = await createYamlPlayer(
              context.file,
              context.executionConfig,
              context.options,
              (taskStatus) => {
                // --- ⭐ 核心修复：直接从 taskStatus 中提取数据 ⭐ ---
                // taskStatus 本身包含了当前步骤的索引和 flow 列表
                const stepIndex = taskStatus.currentStep ?? -1;
                const flow = taskStatus.flow; // 直接使用 taskStatus 自带的 flow

                // --- ⭐【改进代码】开始 ⭐ ---
                const currentStepName = taskStatus.name; // 获取当前步骤的名称

                // 1. 仅当步骤名称发生变化时，才输出 TEST:STEP
                if (currentStepName !== lastProcessedStepName) {
                  // 发送 TEST:STEP (步骤开始)
                  this.sendJson({
                    type: 'test:step',
                    file: context.file,
                    step: currentStepName,
                    status: taskStatus.status,
                    duration: 0,
                    error: taskStatus.error?.message || null,
                  });

                  // 更新记忆，下次比较用
                  lastProcessedStepName = currentStepName;
                }
                // --- ⭐【改进代码】结束 ⭐ ---

                // --- ⭐ 核心修复：发送 test:action ⭐ ---
                // 只有当 flow 存在且索引有效时才发送
                if (
                  Array.isArray(flow) &&
                  stepIndex >= 0 &&
                  stepIndex < flow.length
                ) {
                  const currentStepData = flow[stepIndex];
                  const stepAction =
                    Object.keys(currentStepData)[0] || 'unknown';

                  this.sendJson({
                    type: 'test:action',
                    file: context.file,
                    stepIndex: stepIndex,
                    stepAction: stepAction,
                    stepData: currentStepData,
                  });
                }
              },
            );

            const start = Date.now();
            // 包装 player.run()，使其能响应超时或外部取消
            // 因为我们无法修改 player 内部，我们通过外部 AbortSignal 来控制
            const runPromise = player.run();
            // 监听外部取消信号，如果取消，则拒绝这个 Promise
            // 注意：这不会自动停止 player 内部的代码，但会释放 Node.js 的事件循环
            // 配合上面的 cleanupResources 才能真正停止
            const abortPromise = new Promise((_, reject) => {
              if (this.abortController.signal.aborted) {
                reject(new Error('ExecutionCancelled'));
              }
              this.abortController.signal.addEventListener('abort', () => {
                reject(new Error('ExecutionCancelled'));
              });
            });
            // 竞速：谁先发生算谁的
            await Promise.race([runPromise, abortPromise]);
            const duration = Date.now() - start;

            this.sendJson({
              type: 'test:end',
              file: context.file,
              status: player.status,
              duration,
            });

            // 收集成功结果
            executedResults.push({ file: context.file, player, duration });
          } catch (err: any) {
            // 如果是取消错误，或者运行错误
            if (
              err.message === 'ExecutionCancelled' ||
              err.message === 'Cancelled before start'
            ) {
              // 不处理，让外层逻辑捕获
              throw err;
            }
            // 👇 关键点5：熔断逻辑
            if (!this.config.continueOnError) {
              throw err; // 抛出给外层 catch，触发 break
            }
            // 如果允许继续，则记录错误但不抛出
            notExecutedContexts.push({ file: context.file, player: null });
          }
        });

        // --- ⭐ 关键修复 5：处理 limit 内部的异常 ⭐ ---
        // 如果 limit 包装的函数抛出了异常（例如上面的 throw runError），
        // 它会在这里被捕获。我们需要检查是否是“非继续模式”下的错误。
        // 注意：如果 continueOnError=true，我们在内部已经处理了，不会走到这里。
      } catch (outerError) {
        // 只有在 continueOnError=false 且发生错误时，才会走到这里
        // 此时我们不需要做额外处理，因为上面的逻辑已经发送了消息
        // 我们只需要确保后续的文件不再执行（for 循环会自然停止）

        // 但是，为了防止后续代码继续运行，我们显式地跳出循环
        // 并将剩余的所有文件标记为未执行
        // 熔断触发或内部严重错误：停止后续任务执行
        console.log('Critical error or熔断触发：停止后续任务执行', outerError);
        break;
      }
    }

    // 6. 处理剩余未执行的任务（仅在熔断发生时，队列中剩下的任务）
    // 注意：我们在循环内部已经处理了“取消”和“熔断”的单个任务标记
    // 这里主要是为了兼容旧逻辑，确保所有未执行的都有记录
    // 但实际上，我们在 continueOnError=false 抛出异常时，已经手动处理了当前项
    // 剩下的项会在下一轮循环开始时被检查到 abortSignal 并标记

    return { executedResults, notExecutedContexts };
  }

  abort() {
    this.abortController.abort(); // 触发取消
  }

  private async processResults(
    executedContexts: Array<MidsceneYamlFileContext & { duration: number }>,
    notExecutedContexts: Array<{
      file: string;
      player: ScriptPlayer<MidsceneYamlScriptEnv> | null;
    }>,
  ): Promise<MidsceneYamlConfigResult[]> {
    const results: MidsceneYamlConfigResult[] = [];

    for (const context of executedContexts) {
      const { file, player, duration } = context;
      // Determine result type based on player and task statuses
      const hasFailedTasks =
        player.taskStatusList?.some((task) => task.status === 'error') ?? false;
      const hasPlayerError = player.status === 'error';

      let success: boolean;
      let resultType: 'success' | 'failed' | 'partialFailed';

      if (hasPlayerError) {
        // Complete failure - player itself failed
        success = false;
        resultType = 'failed';
      } else if (hasFailedTasks) {
        // Partial failure - some tasks failed but execution continued (continueOnError)
        success = false;
        resultType = 'partialFailed';
      } else {
        // Success - all tasks completed successfully
        success = true;
        resultType = 'success';
      }

      let reportFile: string | undefined;

      if (player.reportFile) {
        reportFile = player.reportFile;
      }

      // Check if output file actually exists
      let outputPath: string | undefined = player.output || undefined;
      if (outputPath && !existsSync(outputPath)) {
        outputPath = undefined;
      }

      // Collect specific error messages from player
      let errorMessage: string | undefined;
      if (player.errorInSetup?.message) {
        errorMessage = player.errorInSetup.message;
      } else if (hasPlayerError || hasFailedTasks) {
        const taskErrors = player.taskStatusList
          ?.filter((task) => task.status === 'error' && task.error?.message)
          .map((task) => task.error!.message);
        if (taskErrors && taskErrors.length > 0) {
          errorMessage = taskErrors.join('; ');
        } else if (hasPlayerError) {
          errorMessage = 'Execution failed';
        } else {
          errorMessage = 'Some tasks failed';
        }
      }

      results.push({
        file,
        success,
        executed: true,
        output: outputPath,
        report: reportFile,
        duration,
        resultType,
        error: errorMessage,
      });

      // 发送单个文件的最终结果
      this.sendJson({
        type: 'result',
        file,
        resultType,
        error: errorMessage,
      });
    }

    for (const context of notExecutedContexts) {
      results.push({
        file: context.file,
        success: false,
        executed: false,
        output: undefined,
        report: undefined,
        duration: 0,
        resultType: 'notExecuted',
        error: 'Not executed (previous task failed)',
      });

      this.sendJson({
        type: 'result',
        file: context.file,
        resultType: 'notExecuted',
        error: 'Not executed',
      });
    }

    return results;
  }

  private async loadFileConfig(file: string): Promise<MidsceneYamlScript> {
    const content = readFileSync(file, 'utf8');
    return parseYamlScript(content, file);
  }

  private getSummaryAbsolutePath(): string {
    return resolve(getMidsceneRunSubDir('output'), this.config.summary);
  }

  private printExecutionPlan(): void {
    console.log('   Scripts:');
    for (const file of this.config.files) {
      console.log(`     - ${file}`);
    }
    console.log('📋 Execution plan');
    console.log(`   Concurrency: ${this.config.concurrent}`);
    console.log(`   Keep window: ${this.config.keepWindow}`);
    console.log(`   Headed: ${this.config.headed}`);
    console.log(`   Continue on error: ${this.config.continueOnError}`);
    console.log(
      `   Share browser context: ${this.config.shareBrowserContext ?? false}`,
    );
    console.log(`   Summary output: ${this.config.summary}`);
  }

  private async generateOutputIndex(): Promise<void> {
    // summary field should always have a value now
    const indexPath = resolve(
      getMidsceneRunSubDir('output'),
      this.config.summary,
    );
    const outputDir = dirname(indexPath);

    try {
      mkdirSync(outputDir, { recursive: true });

      const indexData = {
        summary: {
          total: this.results.length,
          successful: this.results.filter((r) => r.resultType === 'success')
            .length,
          failed: this.results.filter((r) => r.resultType === 'failed').length,
          partialFailed: this.results.filter(
            (r) => r.resultType === 'partialFailed',
          ).length,
          notExecuted: this.results.filter(
            (r) => r.resultType === 'notExecuted',
          ).length,
          totalDuration: this.results.reduce(
            (sum, r) => sum + (r.duration || 0),
            0,
          ),
          generatedAt: new Date().toLocaleString(),
        },
        results: this.results.map((result) => ({
          script: relative(outputDir, result.file),
          success: result.success,
          resultType: result.resultType,
          output: result.output
            ? (() => {
                const relativePath = relative(outputDir, result.output);
                return relativePath.startsWith('.')
                  ? relativePath
                  : `./${relativePath}`;
              })()
            : undefined,
          report: result.report
            ? relative(outputDir, result.report)
            : undefined,
          error: result.error,
          duration: result.duration,
        })),
      };

      writeFileSync(indexPath, JSON.stringify(indexData, null, 2));

      //console.log('Execution finished:');
    } catch (error) {
      //console.error('Failed to generate output index:', error);
      this.sendJson({
        type: 'error',
        message: `Failed to generate output index: ${error}`,
      });
    }
  }

  getExecutionSummary(): {
    total: number;
    successful: number;
    failed: number;
    partialFailed: number;
    notExecuted: number;
    totalDuration: number;
  } {
    const successful = this.results.filter(
      (r) => r.resultType === 'success',
    ).length;
    const failed = this.results.filter((r) => r.resultType === 'failed').length;
    const partialFailed = this.results.filter(
      (r) => r.resultType === 'partialFailed',
    ).length;
    const notExecuted = this.results.filter(
      (r) => r.resultType === 'notExecuted',
    ).length;

    return {
      total: this.results.length,
      successful,
      failed,
      partialFailed,
      notExecuted,
      totalDuration: this.results.reduce(
        (sum, r) => sum + (r.duration || 0),
        0,
      ),
    };
  }

  getFailedFiles(): string[] {
    return this.results
      .filter((r) => r.resultType === 'failed')
      .map((r) => r.file);
  }

  getPartialFailedFiles(): string[] {
    return this.results
      .filter((r) => r.resultType === 'partialFailed')
      .map((r) => r.file);
  }

  getNotExecutedFiles(): string[] {
    return this.results
      .filter((r) => r.resultType === 'notExecuted')
      .map((r) => r.file);
  }

  getSuccessfulFiles(): string[] {
    return this.results
      .filter((r) => r.resultType === 'success')
      .map((r) => r.file);
  }

  getResults(): MidsceneYamlConfigResult[] {
    return [...this.results];
  }

  printExecutionSummary(): boolean {
    const summary = this.getExecutionSummary();
    const success =
      summary.failed === 0 &&
      summary.partialFailed === 0 &&
      summary.notExecuted === 0;

    console.log('\n📊 Execution Summary:');
    console.log(`   Total files: ${summary.total}`);
    console.log(`   Successful: ${summary.successful}`);
    console.log(`   Failed: ${summary.failed}`);
    console.log(`   Partial failed: ${summary.partialFailed}`);
    console.log(`   Not executed: ${summary.notExecuted}`);
    console.log(`   Duration: ${(summary.totalDuration / 1000).toFixed(2)}s`);
    console.log(`   Summary: ${this.getSummaryAbsolutePath()}`);

    if (summary.successful > 0) {
      console.log('\n✅ Successful files:');
      this.getSuccessfulFiles().forEach((file) => {
        console.log(`   ${file}`);
      });
    }

    if (summary.failed > 0) {
      console.log('\n❌ Failed files');
      this.getFailedFiles().forEach((file) => {
        console.log(`   ${file}`);
      });
    }

    if (summary.partialFailed > 0) {
      console.log(
        '\n⚠️  Partial failed files (some tasks failed with continueOnError)',
      );
      this.getPartialFailedFiles().forEach((file) => {
        console.log(`   ${file}`);
      });
    }

    if (summary.notExecuted > 0) {
      console.log('\n⏸️ Not executed files');
      this.getNotExecutedFiles().forEach((file) => {
        console.log(`   ${file}`);
      });
    }

    if (success) {
      console.log('\n🎉 All files executed successfully!');
    } else {
      console.log('\n⚠️ Some files failed or were not executed.');
    }

    return success;
  }
}

export { BatchRunnerVscex };
