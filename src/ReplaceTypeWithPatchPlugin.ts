import { Plugin } from 'postgraphile';

// Replaces introspected GraphQL type with table patch type via @patch smart tag
//  @patch [function_argument/member_type name] [table_identifier]
//
//  postgres function argument: @patch entity_patch schema.entities
//  postgres composite type:    @patch entity_child_patch schema.entity_children
export const ReplaceTypeWithPatchPlugin: Plugin = (builder) =>
  builder.hook(
    'GraphQLInputObjectType:fields',
    (inputFields, build, context) => {
      const { getTypeByName, inflection, pgIntrospectionResultsByKind } = build;
      const {
        scope: { isMutationInput, pgIntrospection },
        GraphQLInputObjectType: { name },
      } = context;

      // If the input object type is for a mutation, then let's look for patch smart tags in the
      //  comments of the procedure definition. We can find the procedure by using inflection rules
      //  on the procedure name and matching it to the name of the GraphQL input object type.
      //    eg. create function schema.entity_update(id uuid, row_timestamp timestamp, patch json)
      //        ===> EntityUpdateInput
      //
      // If the input object type is not for a mutation, we'll assume it was generated from a
      //  composite type (and probably a nested object used as an argument to a procedure).
      //  Therefore, we can look for the smart tags on the composite type definition itself.
      //    eg. create type schema.entity_update_type as (id uuid, row_timestamp timestamp, patch json)
      //        ===> EntityUpdateTypeInput
      const patchTags: string | string[] =
        (isMutationInput &&
          pgIntrospectionResultsByKind.procedure.find(
            (proc: any) => inflection.functionInputType(proc) === name
          )?.tags?.patch) ||
        pgIntrospection?.type?.tags?.patch;

      if (
        patchTags &&
        (typeof patchTags === 'string' || typeof patchTags === 'object')
      ) {
        const patchFields = (Array.isArray(patchTags) ? patchTags : [patchTags])
          .map((fieldAndTable) => {
            const [arg, tableId] = fieldAndTable.split(' ');
            // namespace.table => ["namespace", "table"]
            const [tableNamespace, tableName] = tableId.split('.');
            // find introspected table
            const table = pgIntrospectionResultsByKind.class.find(
              (t: any) =>
                t.namespace?.name === tableNamespace && t.name === tableName
            );
            // return tuple of inflected argument name and table patch type
            return [
              inflection.argument(arg),
              inflection.patchType(inflection.tableType(table)),
            ] as [string, string];
          })
          .reduce(
            (res, [mutationArg, patchType]) => ({
              ...res,
              [mutationArg]: {
                type: getTypeByName(patchType),
              },
            }),
            {}
          );

        return {
          ...inputFields,
          ...patchFields,
        };
      }
      return inputFields;
    }
  );
