import { makeWrapResolversPlugin } from 'postgraphile';

// This plugin wraps mutations with a custom resolver that looks for arguments somewhere in the
//  input hierarchy that have had their type replaced with postgraphile patch type via the @patch
//  smart tag (eg. JSON with EntityPatch).
//
// When a patched argument is found, the inflected names of fields in the object are replaced with
//  the names of the actual columns introspected from the database table. This allows the called pg
//  procedure to match the incoming JSON fields to table columns and hydrate a row.
//
//  Postgres definition:  create table entity_table( first_column int, second_column int )
//                        create function update_entity(id uuid, patch json)
//                        comment on function update_entity() is E'@patch patch schema.entity_table'
//
//  Original GraphQL:     mutation updateEntity( input: {
//                          id: UUID,
//                          patch: { firstColumn: Int, secondColumn: Int }
//                        }
//  Transformed GraphQL:  mutation updateEntity( input: {
//                          id: UUID,
//                          patch: { first_column: Int, second_column: Int }
//                        }
export const ResolvePatchFieldsPlugin = makeWrapResolversPlugin(
  ({ scope }, build, field) => {
    // only call our custom resolver if a mutation
    if (
      scope?.isRootMutation &&
      scope?.pgFieldIntrospection?.kind === 'procedure'
    )
      return { build, field };
    return null;
  },
  ({ build, field }) => async (resolve, source, args, context, resolveInfo) => {
    const {
      pgIntrospectionResultsByKind,
      inflection,
      graphql: {
        isListType,
        isNonNullType,
        isInputObjectType,
        isObjectType,
        isInterfaceType,
      },
    } = build;

    // recursive function that transforms any argument with a table patch type to use column fields
    const transform = (type: any, nestedArgs: object | object[]): any => {
      // if a list type (eg. [EntityInput]), just map entries via transform
      if (isListType(type) && Array.isArray(nestedArgs))
        return nestedArgs.map((listItem: any) =>
          transform(type.ofType, listItem)
        );
      // if non-nullable type (eg. EntityInput!), get the base type
      if (isNonNullType(type)) return transform(type.ofType, nestedArgs);

      // graphql type has multiple fields
      if (
        isInputObjectType(type) ||
        isObjectType(type) ||
        isInterfaceType(type)
      ) {
        // Map of @patch inflected argument name to introspected table
        const patchArgAndTableMap = new Map<string, any>();

        // input object types are the only types which will contain patch tags, look for them in
        // procedures and composite types
        if (isInputObjectType(type)) {
          const patchTags =
            pgIntrospectionResultsByKind.procedure.find(
              (proc: any) => inflection.functionInputType(proc) === type.name
            )?.tags?.patch ||
            pgIntrospectionResultsByKind.type.find(
              (compositeType: any) =>
                inflection.inputType(inflection.domainType(compositeType)) ===
                type.name
            )?.tags?.patch;

          // if we found some @patch smart tags, store the arg and table in the map
          if (patchTags) {
            (Array.isArray(patchTags) ? patchTags : [patchTags]).forEach(
              (fieldAndTable) => {
                const [arg, tableId] = fieldAndTable.split(' ');
                // namespace.table => ["namespace", "table"]
                const [tableNamespace, tableName] = tableId.split('.');
                // find introspected table
                const table = pgIntrospectionResultsByKind.class.find(
                  (t: any) =>
                    t.namespace?.name === tableNamespace && t.name === tableName
                );
                patchArgAndTableMap.set(inflection.argument(arg), table);
              }
            );
          }
        }

        // get the sub-fields defined for this type from the graphql schema
        const gqlInputTypeFields = type.getFields();
        // iterate through the (possibly nested) argument names/values provided to the mutation
        return Object.entries(nestedArgs).reduce(
          (res, [arg, val]: [string, any]) => {
            const inputTypeField = gqlInputTypeFields[arg];

            // if we previously found a table, then this is a patch type and we should transform the
            // field names from their inflected name to the actual column name
            if (patchArgAndTableMap.has(arg)) {
              const newJson = patchArgAndTableMap
                .get(arg)
                .attributes.reduce((obj: any, attr: any) => {
                  const fieldName = inflection.column(attr);
                  if (fieldName in val) {
                    return {
                      ...obj,
                      [attr.name]: val[fieldName],
                    };
                  }
                  return obj;
                }, {});

              return { ...res, [arg]: newJson };
            }

            // recurse through the fields of the composite type to look for deeper patches
            return { ...res, [arg]: transform(inputTypeField.type, val) };
          },
          {}
        );
      }

      // probably a scalar type, so return as is
      return nestedArgs;
    };

    if (field.args?.input)
      return resolve(
        source,
        { input: transform(field.args?.input.type, args.input) },
        context,
        resolveInfo
      );

    return resolve(source, args, context, resolveInfo);
  }
);
