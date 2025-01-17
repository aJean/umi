import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { IApi } from '@umijs/types';
import { winPath } from '@umijs/utils';
import { runtimePath, renderReactPath } from './constants';

/**
 * @file 核心 - 生成 umi 项目的入口文件
 */

export function importsToStr(
  imports: { source: string; specifier?: string }[],
) {
  return imports.map((imp) => {
    const { source, specifier } = imp;
    if (specifier) {
      return `import ${specifier} from '${winPath(source)}';`;
    } else {
      return `import '${winPath(source)}';`;
    }
  });
}

export default function (api: IApi) {
  const {
    utils: { Mustache },
  } = api;

  const umiVersion = process.env.MFSU_USE_LATEST_UMI
    ? '3'
    : process.env.UMI_VERSION;
  api.addDepInfo(() => {
    return [
      {
        name: '@umijs/runtime',
        range: umiVersion,
        alias: [runtimePath],
      },
      {
        name: '@umijs/renderer-react',
        range: umiVersion,
        alias: [renderReactPath],
      },
    ];
  });

  api.onGenerateFiles(async (args) => {
    const umiTpl = readFileSync(join(__dirname, 'umi.tpl'), 'utf-8');
    const rendererPath = await api.applyPlugins({
      key: 'modifyRendererPath',
      type: api.ApplyPluginsType.modify,
      initialValue: renderReactPath,
    });
    api.writeTmpFile({
      path: 'umi.ts',
      content: Mustache.render(umiTpl, {
        // @ts-ignore
        enableTitle: api.config.title !== false,
        defaultTitle: api.config.title || '',
        rendererPath: winPath(rendererPath),
        runtimePath,
        rootElement: api.config.mountElementId,
        enableSSR: !!api.config.ssr,
        dynamicImport: !!api.config.dynamicImport,
        entryCode: (
          await api.applyPlugins({
            key: 'addEntryCode',
            type: api.ApplyPluginsType.add,
            initialValue: [],
          })
        ).join('\r\n'),
        entryCodeAhead: (
          await api.applyPlugins({
            key: 'addEntryCodeAhead',
            type: api.ApplyPluginsType.add,
            initialValue: [],
          })
        ).join('\r\n'),
        polyfillImports: importsToStr(
          await api.applyPlugins({
            key: 'addPolyfillImports',
            type: api.ApplyPluginsType.add,
            initialValue: [],
          }),
        ).join('\r\n'),
        importsAhead: importsToStr(
          await api.applyPlugins({
            key: 'addEntryImportsAhead',
            type: api.ApplyPluginsType.add,
            initialValue: [],
          }),
        ).join('\r\n'),
        imports: importsToStr(
          await api.applyPlugins({
            key: 'addEntryImports',
            type: api.ApplyPluginsType.add,
            initialValue: [],
          }),
        ).join('\r\n'),
      }),
    });
  });
}
