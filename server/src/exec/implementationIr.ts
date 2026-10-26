import { z } from 'zod';

export const IMPLEMENTATION_IR_VERSION = 1;

const identifierName = z.string().regex(/^[A-Za-z_$][\w$]*$/u);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const file = z.string().min(1);
const symbol = z.string().regex(/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/u);

export type TypeNode = { kind: 'type'; text: string };
export type Parameter = { name: string; type?: TypeNode | undefined; optional?: boolean | undefined; default?: Expression | undefined; rest?: boolean | undefined };
export type Block = { kind: 'block'; body: Statement[] };
export type Expression =
  | { kind: 'identifier'; name: string }
  | { kind: 'literal'; value: string | number | boolean | null }
  | { kind: 'array'; elements: Expression[] }
  | { kind: 'object'; properties: ({ kind: 'property'; key: string; value: Expression } | { kind: 'spread'; expression: Expression })[] }
  | { kind: 'property_access'; object: Expression; property: Expression; computed: boolean }
  | { kind: 'call'; callee: Expression; arguments: Expression[] }
  | { kind: 'new'; callee: Expression; arguments: Expression[] }
  | { kind: 'await'; expression: Expression }
  | { kind: 'unary'; operator: '!' | '+' | '-' | '~' | 'typeof' | 'void' | 'delete'; argument: Expression }
  | { kind: 'binary'; operator: '==' | '!=' | '===' | '!==' | '<' | '<=' | '>' | '>=' | '+' | '-' | '*' | '/' | '%' | '**' | '|' | '&' | '^' | '<<' | '>>' | '>>>' | 'instanceof' | 'in'; left: Expression; right: Expression }
  | { kind: 'logical'; operator: '&&' | '||' | '??'; left: Expression; right: Expression }
  | { kind: 'assignment'; operator: '=' | '+=' | '-=' | '*=' | '/=' | '%=' | '??=' | '&&=' | '||='; target: Expression; value: Expression }
  | { kind: 'conditional'; test: Expression; consequent: Expression; alternate: Expression }
  | { kind: 'arrow'; params: Parameter[]; body: Expression | Block; async?: boolean | undefined; returnType?: TypeNode | undefined }
  | { kind: 'function_expression'; name?: string | undefined; params: Parameter[]; body: Block; async?: boolean | undefined; returnType?: TypeNode | undefined }
  | { kind: 'spread'; expression: Expression };

export type InterfaceProperty = { name: string; type: TypeNode; optional?: boolean | undefined; readonly?: boolean | undefined };
export type InterfaceMethod = { name: string; params: Parameter[]; returnType?: TypeNode | undefined; optional?: boolean | undefined };
export type Statement =
  | { kind: 'variable_declaration'; declarationKind: 'const' | 'let' | 'var'; name: string; initializer?: Expression | undefined; type?: TypeNode | undefined; export?: boolean | undefined }
  | { kind: 'function_declaration'; name: string; params: Parameter[]; body: Block; returnType?: TypeNode | undefined; export?: boolean | undefined; async?: boolean | undefined }
  | { kind: 'interface_declaration'; name: string; properties: InterfaceProperty[]; methods: InterfaceMethod[]; export?: boolean | undefined }
  | { kind: 'type_alias_declaration'; name: string; type: TypeNode; export?: boolean | undefined }
  | { kind: 'return'; argument?: Expression | undefined }
  | { kind: 'if'; test: Expression; consequent: Statement; alternate?: Statement | undefined }
  | { kind: 'expression_statement'; expression: Expression }
  | { kind: 'throw'; argument: Expression }
  | { kind: 'import'; source: string; names?: { imported: string; local?: string | undefined }[] | undefined; defaultImport?: string | undefined; namespaceImport?: string | undefined; typeOnly?: boolean | undefined }
  | { kind: 'reexport'; source: string; names: { imported: string; exported?: string | undefined }[]; typeOnly?: boolean | undefined };

export type TypeScriptModule = { version: typeof IMPLEMENTATION_IR_VERSION; body: Statement[] };

export const TypeNodeSchema = z.object({ kind: z.literal('type'), text: z.string().min(1) }).strict();
export const ParameterSchema: z.ZodType<Parameter> = z.lazy(() => z.object({
  name: identifierName, type: TypeNodeSchema.optional(), optional: z.boolean().optional(),
  default: ExpressionSchema.optional(), rest: z.boolean().optional(),
}).strict());
export const BlockSchema: z.ZodType<Block> = z.lazy(() => z.object({ kind: z.literal('block'), body: z.array(StatementSchema) }).strict());

export const ExpressionSchema: z.ZodType<Expression> = z.lazy(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('identifier'), name: identifierName }).strict(),
  z.object({ kind: z.literal('literal'), value: z.union([z.string(), z.number().finite(), z.boolean(), z.null()]) }).strict(),
  z.object({ kind: z.literal('array'), elements: z.array(ExpressionSchema) }).strict(),
  z.object({ kind: z.literal('object'), properties: z.array(z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('property'), key: z.string(), value: ExpressionSchema }).strict(),
    z.object({ kind: z.literal('spread'), expression: ExpressionSchema }).strict(),
  ])) }).strict(),
  z.object({ kind: z.literal('property_access'), object: ExpressionSchema, property: ExpressionSchema, computed: z.boolean() }).strict(),
  z.object({ kind: z.literal('call'), callee: ExpressionSchema, arguments: z.array(ExpressionSchema) }).strict(),
  z.object({ kind: z.literal('new'), callee: ExpressionSchema, arguments: z.array(ExpressionSchema) }).strict(),
  z.object({ kind: z.literal('await'), expression: ExpressionSchema }).strict(),
  z.object({ kind: z.literal('unary'), operator: z.enum(['!', '+', '-', '~', 'typeof', 'void', 'delete']), argument: ExpressionSchema }).strict(),
  z.object({ kind: z.literal('binary'), operator: z.enum(['==', '!=', '===', '!==', '<', '<=', '>', '>=', '+', '-', '*', '/', '%', '**', '|', '&', '^', '<<', '>>', '>>>', 'instanceof', 'in']), left: ExpressionSchema, right: ExpressionSchema }).strict(),
  z.object({ kind: z.literal('logical'), operator: z.enum(['&&', '||', '??']), left: ExpressionSchema, right: ExpressionSchema }).strict(),
  z.object({ kind: z.literal('assignment'), operator: z.enum(['=', '+=', '-=', '*=', '/=', '%=', '??=', '&&=', '||=']), target: ExpressionSchema, value: ExpressionSchema }).strict(),
  z.object({ kind: z.literal('conditional'), test: ExpressionSchema, consequent: ExpressionSchema, alternate: ExpressionSchema }).strict(),
  z.object({ kind: z.literal('arrow'), params: z.array(ParameterSchema), body: z.union([ExpressionSchema, BlockSchema]), async: z.boolean().optional(), returnType: TypeNodeSchema.optional() }).strict(),
  z.object({ kind: z.literal('function_expression'), name: identifierName.optional(), params: z.array(ParameterSchema), body: BlockSchema, async: z.boolean().optional(), returnType: TypeNodeSchema.optional() }).strict(),
  z.object({ kind: z.literal('spread'), expression: ExpressionSchema }).strict(),
]));

const ImportSchema = z.object({
  kind: z.literal('import'), source: z.string().min(1),
  names: z.array(z.object({ imported: identifierName, local: identifierName.optional() }).strict()).optional(),
  defaultImport: identifierName.optional(), namespaceImport: identifierName.optional(), typeOnly: z.boolean().optional(),
}).strict().superRefine((value, context) => {
  if (value.namespaceImport && (value.defaultImport || value.names?.length)) context.addIssue({ code: 'custom', message: 'namespace import cannot be combined with default or named imports' });
  if (value.typeOnly && value.defaultImport && value.names?.length) context.addIssue({ code: 'custom', message: 'mixed default and named type-only imports are unsupported' });
});

const InterfacePropertySchema = z.object({ name: identifierName, type: TypeNodeSchema,
  optional: z.boolean().optional(), readonly: z.boolean().optional() }).strict();
const InterfaceMethodSchema = z.object({ name: identifierName, params: z.array(ParameterSchema),
  returnType: TypeNodeSchema.optional(), optional: z.boolean().optional() }).strict();

export const StatementSchema: z.ZodType<Statement> = z.lazy(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('variable_declaration'), declarationKind: z.enum(['const', 'let', 'var']), name: identifierName,
    initializer: ExpressionSchema.optional(), type: TypeNodeSchema.optional(), export: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal('function_declaration'), name: identifierName, params: z.array(ParameterSchema), body: BlockSchema,
    returnType: TypeNodeSchema.optional(), export: z.boolean().optional(), async: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal('interface_declaration'), name: identifierName,
    properties: z.array(InterfacePropertySchema), methods: z.array(InterfaceMethodSchema), export: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal('type_alias_declaration'), name: identifierName, type: TypeNodeSchema, export: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal('return'), argument: ExpressionSchema.optional() }).strict(),
  z.object({ kind: z.literal('if'), test: ExpressionSchema, consequent: StatementSchema, alternate: StatementSchema.optional() }).strict(),
  z.object({ kind: z.literal('expression_statement'), expression: ExpressionSchema }).strict(),
  z.object({ kind: z.literal('throw'), argument: ExpressionSchema }).strict(),
  ImportSchema,
  z.object({ kind: z.literal('reexport'), source: z.string().min(1),
    names: z.array(z.object({ imported: identifierName, exported: identifierName.optional() }).strict()).min(1), typeOnly: z.boolean().optional() }).strict(),
]));

export const TypeScriptModuleSchema = z.object({ version: z.literal(IMPLEMENTATION_IR_VERSION), body: z.array(StatementSchema) }).strict();

export const TypedPatchOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('create_file_ir'), file, module: TypeScriptModuleSchema }).strict(),
  z.object({ op: z.literal('replace_function_ir'), file, symbol, targetId: hash, expectedHash: hash, body: z.array(StatementSchema) }).strict(),
  z.object({ op: z.literal('replace_declaration_ir'), file, symbol, targetId: hash, expectedHash: hash, declaration: StatementSchema }).strict(),
  z.object({ op: z.literal('insert_before_ir'), file, anchor: symbol, declarations: z.array(StatementSchema).min(1) }).strict(),
  z.object({ op: z.literal('insert_after_ir'), file, anchor: symbol, declarations: z.array(StatementSchema).min(1) }).strict(),
]);
export type TypedPatchOp = z.infer<typeof TypedPatchOp>;

export const implementationIrJsonSchema = (schema: z.ZodType): Record<string, unknown> =>
  z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' }) as Record<string, unknown>;
