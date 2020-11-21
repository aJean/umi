import assert from 'assert';
import * as utils from '@umijs/utils';
import Logger from '../Logger/Logger';
import Service from './Service';
import { isValidPlugin, pathToObj } from './utils/pluginUtils';
import { EnableBy, PluginType, ServiceStage } from './enums';
import { ICommand, IHook, IPlugin, IPluginConfig, IPreset } from './types';
import Html from '../Html/Html';

interface IOpts {
  id: string;
  key: string;
  service: Service;
}

export default class PluginAPI {
  id: string;
  key: string;
  service: Service;
  Html: typeof Html;
  utils: typeof utils;
  logger: Logger;

  constructor(opts: IOpts) {
    this.id = opts.id;
    this.key = opts.key;
    this.service = opts.service;
    this.utils = utils;
    this.Html = Html;
    this.logger = new Logger(`umi:plugin:${this.id || this.key}`);
  }

  // TODO: reversed keys
  describe({
    id,
    key,
    config,
    enableBy,
  }: {
    id?: string;
    key?: string;
    config?: IPluginConfig;
    enableBy?: EnableBy | (() => boolean);
  } = {}) {
    const { plugins } = this.service;
    // this.id and this.key is generated automatically
    // so we need to diff first
    if (id && this.id !== id) {
      if (plugins[id]) {
        const name = plugins[id].isPreset ? 'preset' : 'plugin';
        throw new Error(
          `api.describe() failed, ${name} ${id} is already registered by ${plugins[id].path}.`,
        );
      }
      plugins[id] = plugins[this.id];
      plugins[id].id = id;
      delete plugins[this.id];
      this.id = id;
    }
    if (key && this.key !== key) {
      this.key = key;
      plugins[this.id].key = key;
    }

    // core/conifg getDefaultConfig 时候会把注册到 plugin 上的 config 都拿出来
    if (config) {
      plugins[this.id].config = config;
    }

    plugins[this.id].enableBy = enableBy || EnableBy.register;
  }
  
  /**
   * 注册 plugin hook 到内部数组，执行需要通过 applyPlugins
   * 注意这里注册的都是后端插件，并且在注册阶段是以 id 的维度存储的，会在初始化时重构成 key 的存储方式
   * 运行时插件 在 runtime/src/plugin 里面，直接以 key 的形式存储
   * 两种时态在 applyPlugin 时的行为是一致的
   */
  register(hook: IHook) {
    assert(
      hook.key && typeof hook.key === 'string',
      `api.register() failed, hook.key must supplied and should be string, but got ${hook.key}.`,
    );
    assert(
      hook.fn && typeof hook.fn === 'function',
      `api.register() failed, hook.fn must supplied and should be function, but got ${hook.fn}.`,
    );
    this.service.hooksByPluginId[this.id] = (
      this.service.hooksByPluginId[this.id] || []
    ).concat(hook);
  }

  registerCommand(command: ICommand) {
    const { name, alias } = command;
    assert(
      !this.service.commands[name],
      `api.registerCommand() failed, the command ${name} is exists.`,
    );
    this.service.commands[name] = command;
    if (alias) {
      this.service.commands[alias] = name;
    }
  }

  // 在插件内部再次注册？会在 initPreset 时处理
  registerPresets(presets: (IPreset | string)[]) {
    assert(
      this.service.stage === ServiceStage.initPresets,
      `api.registerPresets() failed, it should only used in presets.`,
    );
    assert(
      Array.isArray(presets),
      `api.registerPresets() failed, presets must be Array.`,
    );
    const extraPresets = presets.map((preset) => {
      return isValidPlugin(preset as any)
        ? (preset as IPreset)
        : pathToObj({
            type: PluginType.preset,
            path: preset as string,
            cwd: this.service.cwd,
          });
    });
    // 插到最前面，下个 while 循环优先执行
    this.service._extraPresets.splice(0, 0, ...extraPresets);
  }

  // 在 preset 初始化阶段放后面，在插件注册阶段放前面
  registerPlugins(plugins: (IPlugin | string)[]) {
    assert(
      this.service.stage === ServiceStage.initPresets ||
        this.service.stage === ServiceStage.initPlugins,
      `api.registerPlugins() failed, it should only be used in registering stage.`,
    );
    assert(
      Array.isArray(plugins),
      `api.registerPlugins() failed, plugins must be Array.`,
    );
    const extraPlugins = plugins.map((plugin) => {
      return isValidPlugin(plugin as any)
        ? (plugin as IPreset)
        : pathToObj({
            type: PluginType.plugin,
            path: plugin as string,
            cwd: this.service.cwd,
          });
    });
    if (this.service.stage === ServiceStage.initPresets) {
      this.service._extraPlugins.push(...extraPlugins);
    } else {
      this.service._extraPlugins.splice(0, 0, ...extraPlugins);
    }
  }

  /**
   * 如果没传 fn，其实就是注册了一个便捷的 alias register 方法，调用时不需要传 key...
   */
  registerMethod({
    name,
    fn,
    exitsError = true,
  }: {
    name: string;
    fn?: Function;
    exitsError?: boolean;
  }) {
    if (this.service.pluginMethods[name]) {
      if (exitsError) {
        throw new Error(
          `api.registerMethod() failed, method ${name} is already exist.`,
        );
      } else {
        return;
      }
    }
    this.service.pluginMethods[name] =
      fn ||
      // 这里不能用 arrow function，this 需指向执行此方法的 PluginAPI
      // 否则 pluginId 会不对，导致不能正确 skip plugin
      // 对每个 插件 init 时候都会通过 getPluginAPI 创建一个 new PluginAPI 代理对象，并且把 pluginId 传给 api 对象
      function (fn: Function) {
        const hook = {
          key: name,
          ...(utils.lodash.isPlainObject(fn) ? fn : { fn }),
        };
        // 就是这里需要获取 this.id 注册到 this.service.hooksByPluginId
        this.register(hook);
      };
  }

  /**
   * 通过 id 设置可以跳过的插件
   */
  skipPlugins(pluginIds: string[]) {
    pluginIds.forEach((pluginId) => {
      this.service.skipPluginIds.add(pluginId);
    });
  }
}
