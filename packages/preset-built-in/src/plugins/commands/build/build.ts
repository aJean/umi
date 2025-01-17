import { IApi } from '@umijs/types';
import { relative } from 'path';
import { existsSync } from 'fs';
import { Logger } from '@umijs/core';
import {
  cleanTmpPathExceptCache,
  getBundleAndConfigs,
  printFileSizes,
} from '../buildDevUtils';
import generateFiles from '../generateFiles';

const logger = new Logger('umi:preset-build-in');
 
// umi build 实现，可以通过 api.service.runCommand 调用
// 可以看到一般插件的初始化就是拿到 service 代理的 api，执行 registerCommand
export default function (api: IApi) {
  const {
    paths,
    utils: { rimraf },
  } = api;

  api.registerCommand({
    name: 'build',
    description: 'build application for production',
    fn: async function () {
      cleanTmpPathExceptCache({
        absTmpPath: paths.absTmpPath!,
      });

      // generate files，触发 onGenerateFiles 生命周期
      // 因为 generateFiles 是在 core service 之外实现的，所以需要把 api 对象传进去，但是感觉这个可以放到 core 里去实现
      await generateFiles({ api, watch: false });

      // build
      const {
        bundler,
        bundleConfigs,
        bundleImplementor,
      } = await getBundleAndConfigs({ api });
      try {
        // clear output path before exec build
        if (process.env.CLEAR_OUTPUT !== 'none') {
          if (paths.absOutputPath && existsSync(paths.absOutputPath || '')) {
            logger.debug(`Clear OutputPath: ${paths.absNodeModulesPath}`);
            rimraf.sync(paths.absOutputPath);
          }
        }

        const { stats } = await bundler.build({
          bundleConfigs,
          bundleImplementor,
        });
        if (process.env.RM_TMPDIR !== 'none') {
          cleanTmpPathExceptCache({
            absTmpPath: paths.absTmpPath!,
          });
        }
        printFileSizes(stats, relative(process.cwd(), paths.absOutputPath!));
        await api.applyPlugins({
          key: 'onBuildComplete',
          type: api.ApplyPluginsType.event,
          args: {
            stats,
          },
        });
      } catch (err) {
        await api.applyPlugins({
          key: 'onBuildComplete',
          type: api.ApplyPluginsType.event,
          args: {
            err,
          },
        });
        // throw build error
        throw err;
      }
    },
  });
}
