import { IConfig } from '@umijs/types';
import defaultWebpack from 'webpack';
import webpackDevMiddleware from 'webpack-dev-middleware';
import { IServerOpts, Server } from '@umijs/server';
import { ConfigType } from '@umijs/bundler-utils';
import getConfig, { IOpts as IGetConfigOpts } from './getConfig/getConfig';

/**
 * @file 封装 webpack 构建类
 * see preset-built-in/src/plugins/commands/buildDevUtils.ts
 */

interface IOpts {
  cwd: string;
  config: IConfig;
}

class Bundler {
  static id = 'webpack';
  static version = 4;
  cwd: string;
  config: IConfig;

  constructor({ cwd, config }: IOpts) {
    this.cwd = cwd;
    this.config = config;
  }

  async getConfig(
    opts: Omit<IGetConfigOpts, 'cwd' | 'config'>,
  ): Promise<defaultWebpack.Configuration> {
    return await getConfig({
      ...opts,
      cwd: this.cwd,
      config: this.config, // api.config 也就是 core/service 里收集到的用户配置
    });
  }

  async build({
    bundleConfigs,
    bundleImplementor = defaultWebpack,
  }: {
    bundleConfigs: defaultWebpack.Configuration[];
    bundleImplementor?: typeof defaultWebpack;
  }): Promise<{ stats: defaultWebpack.Stats }> {
    return new Promise((resolve, reject) => {
      const compiler = bundleImplementor(bundleConfigs);
      compiler.run((err, stats) => {
        if (err || stats.hasErrors()) {
          try {
            console.log(stats.toString('errors-only'));
          } catch (e) {}
          return reject(new Error('build failed'));
        }
        resolve({ stats });
      });
    });
  }
  
  /**
   * 用于 preset-built-in/src/plugins/commands/dev/dev.ts，本地开发模式
   */
  setupDevServerOpts({
    bundleConfigs,
    bundleImplementor = defaultWebpack,
  }: {
    bundleConfigs: defaultWebpack.Configuration[];
    bundleImplementor?: typeof defaultWebpack;
  }): IServerOpts {
    // 如果没有用户定制，就是 webpack
    const compiler = bundleImplementor(bundleConfigs);
    // @ts-ignore
    const compilerMiddleware = webpackDevMiddleware(compiler, {
      publicPath: '/',
      logLevel: 'silent',
      watchOptions: {
        ignored:
          process.env.WATCH_IGNORED === 'none'
            ? undefined
            : new RegExp(process.env.WATCH_IGNORED || 'node_modules'),
      },
    });

    function sendStats({
      server,
      sockets,
      stats,
    }: {
      server: Server;
      sockets: any;
      stats: defaultWebpack.Stats.ToJsonOutput;
    }) {
      server.sockWrite({ sockets, type: 'hash', data: stats.hash });

      if (stats.errors.length > 0) {
        server.sockWrite({ sockets, type: 'errors', data: stats.errors });
      } else if (stats.warnings.length > 0) {
        server.sockWrite({ sockets, type: 'warnings', data: stats.warnings });
      } else {
        server.sockWrite({ sockets, type: 'ok' });
      }
    }

    function getStats(stats: defaultWebpack.Stats) {
      return stats.toJson({
        all: false,
        hash: true,
        assets: true,
        warnings: true,
        errors: true,
        errorDetails: false,
      });
    }

    let _stats: defaultWebpack.Stats | null = null;

    return {
      compilerMiddleware,
      onListening: ({ server }) => {
        function addHooks(compiler: defaultWebpack.Compiler) {
          const { compile, invalid, done } = compiler.hooks;

          // 把状态发到 server，再发到浏览器 ？
          compile.tap('umi-dev-server', () => {
            server.sockWrite({ type: 'invalid' });
          });
          invalid.tap('umi-dev-server', () => {
            server.sockWrite({ type: 'invalid' });
          });
          done.tap('umi-dev-server', (stats) => {
            sendStats({
              server,
              sockets: server.sockets,
              stats: getStats(stats),
            });
            _stats = stats;
          });
        }
        if (compiler.compilers) {
          compiler.compilers.forEach(addHooks);
        } else {
          addHooks(compiler as any);
        }
      },
      onConnection: ({ connection, server }) => {
        if (_stats) {
          sendStats({
            server,
            sockets: [connection],
            stats: getStats(_stats),
          });
        }
      },
    };
  }
}

export { Bundler, ConfigType, defaultWebpack as webpack };
