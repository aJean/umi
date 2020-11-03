import { IApi } from '@umijs/types';
import joi2Types from 'joi2types';
import joi from '@hapi/joi';

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
    const content = await joi2Types(joi.object(properties).unknown(), {
      interfaceName: 'IConfigFromPlugins',
      bannerComment: '/** Created by Umi Plugin **/',
    });
    api.writeTmpFile({
      path: 'core/pluginConfig.d.ts',
      content,
    });
  });
};
