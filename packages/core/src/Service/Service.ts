import { join } from 'path';
import { EventEmitter } from 'events';
import assert from 'assert';
import { BabelRegister, lodash, NodeEnv } from '@umijs/utils';
import { AsyncSeriesWaterfallHook } from '@umijs/deps/compiled/tapable';
import { existsSync } from 'fs';
import Logger from '../Logger/Logger';
import { pathToObj, resolvePlugins, resolvePresets } from './utils/pluginUtils';
import loadDotEnv from './utils/loadDotEnv';
import isPromise from './utils/isPromise';
import PluginAPI from './PluginAPI';
import {
  ApplyPluginsType,
  ConfigChangeType,
  EnableBy,
  PluginType,
  ServiceStage,
} from './enums';
import { ICommand, IHook, IPackage, IPlugin, IPreset } from './types';
import Config from '../Config/Config';
import { getUserConfigWithKey } from '../Config/utils/configUtils';
import getPaths from './getPaths';

const logger = new Logger('umi:core:Service');

export interface IServiceOpts {
  cwd: string;
  pkg?: IPackage;
  presets?: string[];
  plugins?: string[];
  configFiles?: string[];
  env?: NodeEnv;
}

interface IConfig {
  presets?: string[];
  plugins?: string[];
  [key: string]: any;
}

// TODO
// 1. duplicated key
export default class Service extends EventEmitter {
  cwd: string;
  pkg: IPackage;
  skipPluginIds: Set<string> = new Set<string>();
  // lifecycle stage
  stage: ServiceStage = ServiceStage.uninitialized;
  // registered commands
  commands: {
    [name: string]: ICommand | string;
  } = {};
  // including presets and plugins
  plugins: {
    [id: string]: IPlugin;
  } = {};
  // plugin methods
  pluginMethods: {
    [name: string]: Function;
  } = {};
  // initial presets and plugins from arguments, config, process.env, and package.json
  initialPresets: IPreset[];
  initialPlugins: IPlugin[];
  // presets and plugins for registering
  _extraPresets: IPreset[] = [];
  _extraPlugins: IPlugin[] = [];
  // user config
  userConfig: IConfig;
  configInstance: Config;
  config: IConfig | null = null;
  // babel register
  babelRegister: BabelRegister;
  // hooks
  hooksByPluginId: {
    [id: string]: IHook[];
  } = {};
  hooks: {
    [key: string]: IHook[];
  } = {};
  // paths
  paths: {
    cwd?: string;
    absNodeModulesPath?: string;
    absSrcPath?: string;
    absPagesPath?: string;
    absOutputPath?: string;
    absTmpPath?: string;
  } = {};
  env: string | undefined;
  ApplyPluginsType = ApplyPluginsType;
  EnableBy = EnableBy;
  ConfigChangeType = ConfigChangeType;
  ServiceStage = ServiceStage;
  args: any;

  constructor(opts: IServiceOpts) {
    super();

    logger.debug('opts:');
    logger.debug(opts);
    this.cwd = opts.cwd || process.cwd();
    // repoDir should be the root dir of repo
    this.pkg = opts.pkg || this.resolvePackage();
    this.env = opts.env || process.env.NODE_ENV;

    assert(existsSync(this.cwd), `cwd ${this.cwd} does not exist.`);

    // register babel before config parsing
    this.babelRegister = new BabelRegister();

    // load .env or .local.env
    logger.debug('load env');
    this.loadEnv();

    // get user config without validation
    logger.debug('get user config');
    const configFiles = opts.configFiles;
    this.configInstance = new Config({
      cwd: this.cwd,
      service: this,
      localConfig: this.env === 'development',
      configFiles:
        Array.isArray(configFiles) && !!configFiles[0]
          ? configFiles
          : undefined,
    });
    this.userConfig = this.configInstance.getUserConfig();
    logger.debug('userConfig:');
    logger.debug(this.userConfig);

    // get paths
    this.paths = getPaths({
      cwd: this.cwd,
      config: this.userConfig!,
      env: this.env,
    });
    logger.debug('paths:');
    logger.debug(this.paths);

    // setup initial presets and plugins
    const baseOpts = {
      pkg: this.pkg,
      cwd: this.cwd,
    };
    // 将 path 转化成 plugin obj 保存，会自动生成唯一 id => { id，key, apply }
    this.initialPresets = resolvePresets({
      ...baseOpts,
      presets: opts.presets || [],
      userConfigPresets: this.userConfig.presets || [],
    });

    // 将 path 转化成 plugin obj 保存，会自动生成唯一 id => { id，key, apply }
    // .umirc 里面定义的 plugins
    this.initialPlugins = resolvePlugins({
      ...baseOpts,
      plugins: opts.plugins || [],
      userConfigPlugins: this.userConfig.plugins || [],
    });
    this.babelRegister.setOnlyMap({
      key: 'initialPlugins',
      value: lodash.uniq([
        ...this.initialPresets.map(({ path }) => path),
        ...this.initialPlugins.map(({ path }) => path),
      ]),
    });
    logger.debug('initial presets:');
    logger.debug(this.initialPresets);
    logger.debug('initial plugins:');
    logger.debug(this.initialPlugins);
  }

  setStage(stage: ServiceStage) {
    this.stage = stage;
  }

  resolvePackage() {
    try {
      return require(join(this.cwd, 'package.json'));
    } catch (e) {
      return {};
    }
  }

  loadEnv() {
    const basePath = join(this.cwd, '.env');
    const localPath = `${basePath}.local`;
    loadDotEnv(localPath);
    loadDotEnv(basePath);
  }

  async init() {
    this.setStage(ServiceStage.init);
    // we should have the final hooksByPluginId which is added with api.register()
    await this.initPresetsAndPlugins();

    // hooksByPluginId -> hooks，把根据 plugin id 存储的 hooks 映射为 key 存储
    // 这里也要注意异步注册的插件是无效的！！
    this.setStage(ServiceStage.initHooks);
    Object.keys(this.hooksByPluginId).forEach((id) => {
      const hooks = this.hooksByPluginId[id];
      hooks.forEach((hook) => {
        const { key } = hook;
        hook.pluginId = id;
        this.hooks[key] = (this.hooks[key] || []).concat(hook);
      });
    });

    // plugin is totally ready
    this.setStage(ServiceStage.pluginReady);
    await this.applyPlugins({
      key: 'onPluginReady',
      type: ApplyPluginsType.event,
    });

    // get config, including: 1. merge default config 2. validate
    // 先拿到配置项的 default 然后作为 initValue 获取一个完整的 config
    this.setStage(ServiceStage.getConfig);
    const defaultConfig = await this.applyPlugins({
      key: 'modifyDefaultConfig',
      type: this.ApplyPluginsType.modify,
      initialValue: await this.configInstance.getDefaultConfig(),
    });
    // 可以在插件里通过 api.modifyConfig() 修改
    this.config = await this.applyPlugins({
      key: 'modifyConfig',
      type: this.ApplyPluginsType.modify,
      initialValue: this.configInstance.getConfig({
        defaultConfig,
      }) as any,
    });

    // merge paths to keep the this.paths ref
    this.setStage(ServiceStage.getPaths);
    // config.outputPath may be modified by plugins
    if (this.config!.outputPath) {
      this.paths.absOutputPath = join(this.cwd, this.config!.outputPath);
    }
    const paths = (await this.applyPlugins({
      key: 'modifyPaths',
      type: ApplyPluginsType.modify,
      initialValue: this.paths,
    })) as object;
    Object.keys(paths).forEach((key) => {
      this.paths[key] = paths[key];
    });
  }

  /**
   * 初始化插件和插件集
   */
  async initPresetsAndPlugins() {
    this.setStage(ServiceStage.initPresets);
    this._extraPlugins = [];
    while (this.initialPresets.length) {
      await this.initPreset(this.initialPresets.shift()!);
    }

    this.setStage(ServiceStage.initPlugins);
    this._extraPlugins.push(...this.initialPlugins);
    while (this._extraPlugins.length) {
      await this.initPlugin(this._extraPlugins.shift()!);
    }
  }
  
  getPluginAPI(opts: any) {
    const pluginAPI = new PluginAPI(opts);

    // register built-in methods
    [
      'onPluginReady',
      'modifyPaths',
      'onStart',
      'modifyDefaultConfig',
      'modifyConfig',
    ].forEach((name) => {
      pluginAPI.registerMethod({ name, exitsError: false });
    });

    // 返回代理对象，无法通过 api.xx set
    return new Proxy(pluginAPI, {
      get: (target, prop: string) => {
        // 由于 pluginMethods 需要在 register 阶段可用，必须通过 proxy 的方式动态获取最新，以实现边注册边使用的效果
        // 也就是这里需要动态查找，要么做成 fn，要么用 proxy
        // 我理解主要是因为 service 与 pluginAPI 是两个对象，而且 register 都是注册到 service 上面
        if (this.pluginMethods[prop]) return this.pluginMethods[prop];
        if (
          [
            'applyPlugins',
            'ApplyPluginsType',
            'EnableBy',
            'ConfigChangeType',
            'babelRegister',
            'stage',
            'ServiceStage',
            'paths',
            'cwd',
            'pkg',
            'userConfig',
            'config',
            'env',
            'args',
            'hasPlugins',
            'hasPresets',
          ].includes(prop)
        ) {
          return typeof this[prop] === 'function'
            ? this[prop].bind(this)
            : this[prop];
        }
        return target[prop];
      },
    });
  }

  async applyAPI(opts: { apply: Function; api: PluginAPI }) {
    let ret = opts.apply()(opts.api);
    if (isPromise(ret)) {
      ret = await ret;
    }
    return ret || {};
  }

  async initPreset(preset: IPreset) {
    const { id, key, apply } = preset;
    preset.isPreset = true;

    const api = this.getPluginAPI({ id, key, service: this });

    // register before apply
    this.registerPlugin(preset);
    // TODO: ...defaultConfigs 考虑要不要支持，可能这个需求可以通过其他渠道实现
    const { presets, plugins, ...defaultConfigs } = await this.applyAPI({
      api,
      apply,
    });

    // register extra presets and plugins
    if (presets) {
      assert(
        Array.isArray(presets),
        `presets returned from preset ${id} must be Array.`,
      );
      // presets 的策略是立即执行
      // 使用 _extraPresets 的目的是不影响 this.initialPresets
      this._extraPresets.splice(
        0,
        0,
        ...presets.map((path: string) => {
          return pathToObj({
            type: PluginType.preset,
            path,
            cwd: this.cwd,
          });
        }),
      );
    }

    const extraPresets = lodash.clone(this._extraPresets);
    // 插件内部可能会通过 api.registerPresets 再注册 Presets，不过我觉得没必要在提供这种机制了，反而会麻烦
    this._extraPresets = [];
    while (extraPresets.length) {
      await this.initPreset(extraPresets.shift()!);
    }

    if (plugins) {
      assert(
        Array.isArray(plugins),
        `plugins returned from preset ${id} must be Array.`,
      );
      // plugins 的策略是延后执行，在 initPresetsAndPlugins 循环里执行
      this._extraPlugins.push(
        ...plugins.map((path: string) => {
          return pathToObj({
            type: PluginType.plugin,
            path,
            cwd: this.cwd,
          });
        }),
      );
    }
  }

  async initPlugin(plugin: IPlugin) {
    const { id, key, apply } = plugin;

    const api = this.getPluginAPI({ id, key, service: this });

    // register before apply
    this.registerPlugin(plugin);
    await this.applyAPI({ api, apply });
  }

  getPluginOptsWithKey(key: string) {
    return getUserConfigWithKey({
      key,
      userConfig: this.userConfig,
    });
  }

  registerPlugin(plugin: IPlugin) {
    // 考虑要不要去掉这里的校验逻辑
    // 理论上不会走到这里，因为在 describe 的时候已经做了冲突校验
    if (this.plugins[plugin.id]) {
      const name = plugin.isPreset ? 'preset' : 'plugin';
      throw new Error(`\
${name} ${plugin.id} is already registered by ${this.plugins[plugin.id].path}, \
${name} from ${plugin.path} register failed.`);
    }
    this.plugins[plugin.id] = plugin;
  }
  
  /**
   * 判断插件是否可用
   */
  isPluginEnable(pluginId: string) {
    // api.skipPlugins() 的插件
    if (this.skipPluginIds.has(pluginId)) return false;

    const { key, enableBy } = this.plugins[pluginId];

    // 手动设置为 false
    if (this.userConfig[key] === false) return false;

    // 配置开启
    if (enableBy === this.EnableBy.config && !(key in this.userConfig)) {
      return false;
    }

    // 函数自定义开启
    if (typeof enableBy === 'function') {
      return enableBy();
    }

    // 注册开启
    return true;
  }

  hasPlugins(pluginIds: string[]) {
    return pluginIds.every((pluginId) => {
      const plugin = this.plugins[pluginId];
      return plugin && !plugin.isPreset && this.isPluginEnable(pluginId);
    });
  }

  hasPresets(presetIds: string[]) {
    return presetIds.every((presetId) => {
      const preset = this.plugins[presetId];
      return preset && preset.isPreset && this.isPluginEnable(presetId);
    });
  }

  async applyPlugins(opts: {
    key: string;
    type: ApplyPluginsType;
    initialValue?: any;
    args?: any;
  }) {
    const hooks = this.hooks[opts.key] || [];
    switch (opts.type) {
      case ApplyPluginsType.add:
        if ('initialValue' in opts) {
          assert(
            Array.isArray(opts.initialValue),
            `applyPlugins failed, opts.initialValue must be Array if opts.type is add.`,
          );
        }
        const tAdd = new AsyncSeriesWaterfallHook(['memo']);
        for (const hook of hooks) {
          // 跳过插件
          if (!this.isPluginEnable(hook.pluginId!)) {
            continue;
          }
          tAdd.tapPromise(
            {
              name: hook.pluginId!,
              stage: hook.stage || 0,
              // @ts-ignore
              before: hook.before,
            },
            async (memo: any[]) => {
              const items = await hook.fn(opts.args);
              return memo.concat(items);
            },
          );
        }
        return await tAdd.promise(opts.initialValue || []);
      case ApplyPluginsType.modify:
        const tModify = new AsyncSeriesWaterfallHook(['memo']);
        for (const hook of hooks) {
          if (!this.isPluginEnable(hook.pluginId!)) {
            continue;
          }
          tModify.tapPromise(
            {
              name: hook.pluginId!,
              stage: hook.stage || 0,
              // @ts-ignore
              before: hook.before,
            },
            async (memo: any) => {
              return await hook.fn(memo, opts.args);
            },
          );
        }
        return await tModify.promise(opts.initialValue);
      case ApplyPluginsType.event:
        const tEvent = new AsyncSeriesWaterfallHook(['_']);
        for (const hook of hooks) {
          if (!this.isPluginEnable(hook.pluginId!)) {
            continue;
          }
          tEvent.tapPromise(
            {
              name: hook.pluginId!,
              stage: hook.stage || 0,
              // @ts-ignore
              before: hook.before,
            },
            async () => {
              await hook.fn(opts.args);
            },
          );
        }
        return await tEvent.promise();
      default:
        throw new Error(
          `applyPlugin failed, type is not defined or is not matched, got ${opts.type}.`,
        );
    }
  }

  async run({ name, args = {} }: { name: string; args?: any }) {
    args._ = args._ || [];
    // shift the command itself
    if (args._[0] === name) args._.shift();

    this.args = args;
    await this.init();

    logger.debug('plugins:');
    logger.debug(this.plugins);

    this.setStage(ServiceStage.run);
    await this.applyPlugins({
      key: 'onStart',
      type: ApplyPluginsType.event,
      args: {
        args,
      },
    });
    return this.runCommand({ name, args });
  }

  /**
   * 执行命令，因为 ServiceWithBuiltin 会先注册插件，所以这里可以找到注册的命令
   */
  async runCommand({ name, args = {} }: { name: string; args?: any }) {
    assert(this.stage >= ServiceStage.init, `service is not initialized.`);

    args._ = args._ || [];
    // shift the command itself
    if (args._[0] === name) args._.shift();

    const command =
      typeof this.commands[name] === 'string'
        ? this.commands[this.commands[name] as string]
        : this.commands[name];
    assert(command, `run command failed, command ${name} does not exists.`);

    const { fn } = command as ICommand;
    return fn({ args });
  }
}
