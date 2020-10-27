import { makePluginByCombiningPlugins } from 'postgraphile';
import { ReplaceTypeWithPatchPlugin } from './ReplaceTypeWithPatchPlugin';
import { ResolvePatchFieldsPlugin } from './ResolvePatchFieldsPlugin';

const JsonPatchPlugin = makePluginByCombiningPlugins(
  ReplaceTypeWithPatchPlugin,
  ResolvePatchFieldsPlugin
);

export default JsonPatchPlugin;
