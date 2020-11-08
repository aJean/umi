import { IApi } from '@umijs/types';
import { IServerOpts, Server } from '@umijs/server';
import { delay } from '@umijs/utils';
import assert from 'assert';
import { cleanTmpPathExceptCache, getBundleAndConfigs } from '../buildDevUtils';
import createRouteMiddleware from './createRouteMiddleware';
import generateFiles from '../generateFiles';
import { watchPkg } from './watchPkg';

export default (api: IApi) => {
  const {
    env,
    paths,
    utils: { chalk, portfinder },
  } = api;

  let port: number;
  let hostname: string;
  let server: Server;
  const unwatchs: Function[] = [];

  // 要把之前注册的监听函数全部注销
  function destroy() {
    for (const unwatch of unwatchs) {
      unwatch();
    }
    server?.listeningApp?.close();
  }

  const sharedMap = new Map();
  api.onDevCompileDone(({ stats }) => {
    // store chunks
    sharedMap.set('chunks', stats.compilation.chunks);
  });

  api.registerCommand({
    name: 'dev',
    description: 'start a dev server for development',
    fn: async function ({ args }) {
      const defaultPort =
        process.env.PORT || args?.port || api.config.devServer?.port;
      port = await portfinder.getPortPromise({
        port: defaultPort ? parseInt(String(defaultPort), 10) : 8000,
      });
      hostname = process.env.HOST || api.config.devServer?.host || '0.0.0.0';
      console.log(chalk.cyan('Starting the development server...'));
      process.send?.({ type: 'UPDATE_PORT', port });

      cleanTmpPathExceptCache({
        absTmpPath: paths.absTmpPath!,
      });
      const watch = process.env.WATCH !== 'none';

      // 执行 generate files 生成中间态文件系统，返回的是注销监听函数
      const unwatchGenerateFiles = await generateFiles({ api, watch });
      if (unwatchGenerateFiles) unwatchs.push(unwatchGenerateFiles);

      if (watch) {
        //监听 npm 包变化
        const unwatchPkg = watchPkg({
          cwd: api.cwd,
          onChange() {
            console.log();
            api.logger.info(`Plugins in package.json changed.`);
            api.restartServer();
          },
        });
        unwatchs.push(unwatchPkg);

        // watch config change
        const unwatchConfig = api.service.configInstance.watch({
          userConfig: api.service.userConfig,
          onChange: async ({ pluginChanged, userConfig, valueChanged }) => {
            if (pluginChanged.length) {
              console.log();
              api.logger.info(
                `Plugins of ${pluginChanged
                  .map((p) => p.key)
                  .join(', ')} changed.`,
              );
              api.restartServer();
            }
            if (valueChanged.length) {
              let reload = false;
              let regenerateTmpFiles = false;
              const fns: Function[] = [];
              const reloadConfigs: string[] = [];
              valueChanged.forEach(({ key, pluginId }) => {
                const { onChange } = api.service.plugins[pluginId].config || {};
                if (onChange === api.ConfigChangeType.regenerateTmpFiles) {
                  regenerateTmpFiles = true;
                }
                if (!onChange || onChange === api.ConfigChangeType.reload) {
                  reload = true;
                  reloadConfigs.push(key);
                }
                if (typeof onChange === 'function') {
                  fns.push(onChange);
                }
              });

              if (reload) {
                // reload 需要重建进程
                api.logger.info(`Config ${reloadConfigs.join(', ')} changed.`);
                api.restartServer();
              } else {
                api.service.userConfig = api.service.configInstance.getUserConfig();

                // TODO: simplify, 和 Service 里的逻辑重复了
                // 需要 Service 露出方法
                const defaultConfig = await api.applyPlugins({
                  key: 'modifyDefaultConfig',
                  type: api.ApplyPluginsType.modify,
                  initialValue: await api.service.configInstance.getDefaultConfig(),
                });
                api.service.config = await api.applyPlugins({
                  key: 'modifyConfig',
                  type: api.ApplyPluginsType.modify,
                  initialValue: api.service.configInstance.getConfig({
                    defaultConfig,
                  }) as any,
                });

                // 文件级改变 webpackDevMiddleware 都监听处理
                // 但是需要区分是否需要重新生成 tmp
                if (regenerateTmpFiles) {
                  await generateFiles({ api });
                } else {
                  fns.forEach((fn) => fn());
                }
              }
            }
          },
        });
        unwatchs.push(unwatchConfig);
      }

      // delay dev server 启动，避免重复 compile
      // https://github.com/webpack/watchpack/issues/25
      // https://github.com/yessky/webpack-mild-compile
      await delay(500);

      // dev
      const {
        bundler,
        bundleConfigs,
        bundleImplementor,
      } = await getBundleAndConfigs({ api, port });
      // 使用 bundleConfigs 创建启动 webpackDevMiddleware
      const opts: IServerOpts = bundler.setupDevServerOpts({
        bundleConfigs: bundleConfigs,
        bundleImplementor,
      });

      const beforeMiddlewares = await api.applyPlugins({
        key: 'addBeforeMiddewares',
        type: api.ApplyPluginsType.add,
        initialValue: [],
        args: {},
      });
      const middlewares = await api.applyPlugins({
        key: 'addMiddewares',
        type: api.ApplyPluginsType.add,
        initialValue: [],
        args: {},
      });

      // 启动 mock server，设置了 cors
      const server = new Server({
        ...opts,
        compress: true,
        headers: {
          'access-control-allow-origin': '*',
        },
        proxy: api.config.proxy,
        beforeMiddlewares,
        afterMiddlewares: [
          ...middlewares,
          createRouteMiddleware({ api, sharedMap }),
        ],
        ...(api.config.devServer || {}),
      });
      const listenRet = await server.listen({
        port,
        hostname,
      });
      return {
        ...listenRet,
        destroy,
      };
    },
  });

  api.registerMethod({
    name: 'getPort',
    fn() {
      assert(
        env === 'development',
        `api.getPort() is only valid in development.`,
      );
      return port;
    },
  });

  api.registerMethod({
    name: 'getHostname',
    fn() {
      assert(
        env === 'development',
        `api.getHostname() is only valid in development.`,
      );
      return hostname;
    },
  });

  api.registerMethod({
    name: 'getServer',
    fn() {
      assert(
        env === 'development',
        `api.getServer() is only valid in development.`,
      );
      return server;
    },
  });

  api.registerMethod({
    name: 'restartServer',
    fn() {
      console.log(chalk.gray(`Try to restart dev server...`));
      destroy();
      // 向 master 发送重启信号，杀死当前 dev 进程，重新创建 (packages/umi/src/utils/fork.ts)
      process.send?.({ type: 'RESTART' });
    },
  });
};
