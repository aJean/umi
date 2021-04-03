import { IApi } from '@umijs/types';
// @ts-ignore
import joi2Types from '@umijs/deps/compiled/joi2types';
import joi from '@umijs/deps/compiled/@hapi/joi';

/**
 * @file api.describe 定义的 config 生成 pluginConfig.d.ts
 *       然后在 defineConfig 的时候作为参数的类型，对用户配置进行约束
 */

export default (api: IApi) => {
  api.onGenerateFiles(async () => {
    const { service } = api;
    const properties = Object.keys(service.plugins)
      .map((plugin) => {
        const { config, key } = service.plugins[plugin];
        // recognize as key if have schema config
        if (!config?.schema) return;
        const schema = config.schema(joi);
        if (!joi.isSchema(schema)) {
          return;
        }
        return {
          [key]: schema,
        };
      })
      .reduce(
        (acc, curr) => ({
          ...acc,
          ...curr,
        }),
        {},
      );
    const interfaceName = 'IConfigFromPlugins';
    // catch
    const content = await joi2Types(joi.object(properties).unknown(), {
      interfaceName,
      bannerComment: '// Created by Umi Plugin',
    }).catch((err) => {
      api.logger.error('Config types generated error', err);
      return Promise.resolve(`export interface ${interfaceName} {}`);
    });
    api.writeTmpFile({
      path: 'core/pluginConfig.d.ts',
      content,
    });
  });
};
