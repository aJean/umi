import { readFileSync } from 'fs';
import { join } from 'path';
import { IApi } from '@umijs/types';
import { getFile, winPath } from '@umijs/utils';
import { runtimePath } from '../constants';

/**
 * @file 生成运行时插件集
 */

export default function (api: IApi) {
  const {
    paths,
    utils: { Mustache },
  } = api;

  api.onGenerateFiles(async (args) => {
    // 限制 key，我们的插件必须 export 已经注册的 key    
    const validKeys = await api.applyPlugins({
      key: 'addRuntimePluginKey',
      type: api.ApplyPluginsType.add,
      // 运行时的四大默认配置
      initialValue: [
        'modifyClientRenderOpts',
        'patchRoutes',
        'rootContainer',
        'render',
        'onRouteChange',
      ],
    });

    // 拿到所有注册的运行时 plugin
    const plugins = await api.applyPlugins({
      key: 'addRuntimePlugin',
      type: api.ApplyPluginsType.add,
      initialValue: [
        getFile({
          base: paths.absSrcPath!,
          fileNameWithoutExt: 'app',
          type: 'javascript',
        })?.path,
      ].filter(Boolean),
    });

    // 写入 .umi 目录，作为 runtime plugin 声明
    api.writeTmpFile({
      path: 'core/plugin.ts',
      content: Mustache.render(
        readFileSync(join(__dirname, 'plugin.tpl'), 'utf-8'),
        {
          validKeys,
          runtimePath,
        },
      ),
    });
    api.writeTmpFile({
      path: 'core/pluginRegister.ts',
      content: Mustache.render(
        readFileSync(join(__dirname, 'pluginRegister.tpl'), 'utf-8'),
        {
          plugins: plugins.map((plugin: string, index: number) => {
            return {
              index,
              path: winPath(plugin),
            };
          }),
        },
      ),
    });
  });

  // 导出 umi runtime plugin
  api.addUmiExports(() => {
    return {
      specifiers: ['plugin'],
      source: `./plugin`,
    };
  });
}
