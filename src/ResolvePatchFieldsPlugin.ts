import { makeWrapResolversPlugin } from 'postgraphile';

type ArgumentObject = { [index: string]: any };
const getKey = (type: string, arg: string) => `${type}|${arg}`;

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

    // Recurse down through graphql types for mutation inputs, building a map of @patch argument
    // names to the introspected table. This precomputation helps performance during mutation
    // resolution at runtime
    const patchMap = new Map<string, any>();
    const populatePatchMap = (type: any) => {
      if (isListType(type) || isNonNullType(type)) {
        populatePatchMap(type.ofType);
      } else if (
        isInputObjectType(type) ||
        isObjectType(type) ||
        isInterfaceType(type)
      ) {
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
          if (
            patchTags &&
            (typeof patchTags === 'string' || typeof patchTags === 'object')
          ) {
            (Array.isArray(patchTags) ? patchTags : [patchTags]).forEach(
              (fieldAndTable) => {
                const [arg, tableId] = fieldAndTable.split(' ');
                // namespace.table => ["namespace", "table"]
                const [tableNamespace, tableName] = tableId.split('.');
                // find introspected table
                const table = pgIntrospectionResultsByKind.class.find(
                  (table: any) =>
                    table.namespace?.name === tableNamespace &&
                    table.name === tableName
                );
                patchMap.set(
                  getKey(type.name, inflection.argument(arg)),
                  table
                );
              }
            );
          }
        }

        const gqlInputTypeFields = type.getFields();
        Object.values(gqlInputTypeFields).forEach((field) =>
          populatePatchMap(field.type)
        );
      }
    };

    // if this filter is for a procedure-based mutation and an input argument, let's search for
    // patch tags to see if we want to use our custom resolver
    if (
      scope?.isRootMutation &&
      scope?.pgFieldIntrospection?.kind === 'procedure' &&
      field.args?.input
    ) {
      populatePatchMap(field.args?.input.type);

      // only call our resolver if this mutation has @patch tags
      if (patchMap.size > 0) return { build, field, patchMap };
    }
    return null;
  },
  ({ build, field, patchMap }) => async (
    resolve,
    source,
    args,
    context,
    resolveInfo
  ) => {
    const {
      inflection,
      graphql: {
        isListType,
        isNonNullType,
        isInputObjectType,
        isObjectType,
        isInterfaceType,
        isNamedType,
      },
    } = build;

    // recursive function that transforms any argument with a table patch type to use column fields
    const transform = (
      type: any,
      argValues: ArgumentObject | ArgumentObject[]
    ): void => {
      // if a list type (eg. [EntityInput]), just map entries via transform
      if (isListType(type) && Array.isArray(argValues)) {
        argValues.forEach((listItem: ArgumentObject) =>
          transform(type.ofType, listItem)
        );
      }
      // if non-nullable type (eg. EntityInput!), get the base type
      else if (isNonNullType(type)) {
        transform(type.ofType, argValues);
      }
      // graphql type has multiple fields
      else if (
        (isInputObjectType(type) ||
          isObjectType(type) ||
          isInterfaceType(type)) &&
        !Array.isArray(argValues)
      ) {
        // get the sub-fields defined for this type from the graphql schema
        const gqlInputTypeFields = type.getFields();
        // iterate through the (possibly nested) argument names/values provided to the mutation
        Object.entries(argValues).forEach(([arg, val]: [string, any]) => {
          const inputTypeField = gqlInputTypeFields[arg];

          // if we previously found a table, then this is a patch type and we should transform the
          // field names from their inflected name to the actual column name
          const key = getKey(type.name, arg);
          if (patchMap.has(key)) {
            const newJson = patchMap
              .get(key)
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

            argValues[arg] = newJson;
          } else transform(inputTypeField.type, val);
        });
      }
    };

    // destructively transform arguments instead of creating a new object; perf. per Benjie
    transform(field.args?.input.type, args.input);

    return resolve(source, args, context, resolveInfo);
  }
);
