# postgraphile-plugin-json-patch

## About

This plugin let's us leverage postgraphile's auto-generated patch types for use in postgres procedures that update data in views which are not updateable by default. Any view with complex logic (eg. `JOIN`s) are not updateable, and therefore won't be included in postgraphile's default mutations.

When a `@patch` smart tag is included in a function or composite type definition, the type of the column/argument is replaced with the generated patch type of the specified view in the GraphQL schema. When the mutation is resolved, the incoming field for the argument are transformed back from the inflected name to the original column name. This allows the procedure logic to easily hydrate a view row.

## Why?

For user-defined procedures that provide patch-like functionality to a view where an argument is of the `json` type, it is desirable to present the consumer of the GraphQL schema with a strongly-typed definition instead of an opaque `JSON` type.

This can be accomplished by extending the schema via `makeExtendSchemaPlugin`, but explicity defining input types, payload types, and mutation becomes cumbersome and result's in a lot of boilerplate code to maintain.

## Usage

The smart tag definition is: `@patch [argument/column id] [view id]`

### Example

```
create view public.entity ...
create view public.entity_children ...

create type public.entity_children_update (child_id uuid, child_patch json, ...)
comment on type public.entity_children_update is '@patch child_patch public.entity_children'

create function public.update_entity(id uuid, entity_patch json, update_children public.entity_children[]) ...
comment on function public.update_entity() is '@patch entity_patch public.entity'
```
