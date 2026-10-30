import ts from 'typescript';
import type { Block, Expression, Parameter, Statement, TypeNode, TypeScriptModule, TypedPatchOp } from './implementationIr.ts';
import type { SymbolOp } from './symbolOps.ts';

export class TypedPatchCompileError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TypedPatchCompileError';
  }
}

const unsupported = (message: string): never => { throw new TypedPatchCompileError(`Unsupported implementation IR: ${message}`); };
const factory = ts.factory;
const sourceFile = ts.createSourceFile('implementation-ir.ts', '', ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: false });

// Строковый литерал печатается в одинарных кавычках и без ASCII-экранирования: принтер TS по
// умолчанию выдавал `"\u043F\u0430\u043A\u0435\u0442"` вместо `'пакет'` — такую строку не прочитать
// человеку в diff'е, а гейт «Ответы человека в коде» ищет цитату ответа буквально (оракул, vat-rounding).
function stringLiteral(text: string): ts.StringLiteral {
  return ts.setEmitFlags(factory.createStringLiteral(text, true), ts.EmitFlags.NoAsciiEscaping);
}

function compileType(node: TypeNode): ts.TypeNode {
  // Хвостовая `;` в тексте типа — след копирования из объявления (`Map<string, {…}>;`), а не
  // другой тип: корпус r1–r4 показал отказ всей операции из-за неё (mellum, idempotent-retry).
  const text = node.text.trim().replace(/;+$/u, '');
  const parsed = ts.createSourceFile('type.ts', `type ImplementationIrType = ${text};`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const diagnostics = (parsed as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
  if (diagnostics.length || parsed.statements.length !== 1 || !ts.isTypeAliasDeclaration(parsed.statements[0]!))
    throw new TypedPatchCompileError(`Invalid TYPE node: ${node.text}`);
  return (ts as unknown as { getSynthesizedDeepClone(node: ts.TypeNode): ts.TypeNode }).getSynthesizedDeepClone(parsed.statements[0].type);
}

function modifiers(exported?: boolean, async?: boolean): ts.Modifier[] {
  return [
    ...(exported ? [factory.createModifier(ts.SyntaxKind.ExportKeyword)] : []),
    ...(async ? [factory.createModifier(ts.SyntaxKind.AsyncKeyword)] : []),
  ];
}

function compileParameter(parameter: Parameter): ts.ParameterDeclaration {
  return factory.createParameterDeclaration(undefined,
    parameter.rest ? factory.createToken(ts.SyntaxKind.DotDotDotToken) : undefined,
    factory.createIdentifier(parameter.name),
    parameter.optional ? factory.createToken(ts.SyntaxKind.QuestionToken) : undefined,
    parameter.type ? compileType(parameter.type) : undefined,
    parameter.default ? compileExpression(parameter.default) : undefined);
}

const unaryOperators = {
  '!': ts.SyntaxKind.ExclamationToken, '+': ts.SyntaxKind.PlusToken, '-': ts.SyntaxKind.MinusToken,
  '~': ts.SyntaxKind.TildeToken, typeof: ts.SyntaxKind.TypeOfKeyword, void: ts.SyntaxKind.VoidKeyword,
} as const;
const binaryOperators = {
  '==': ts.SyntaxKind.EqualsEqualsToken, '!=': ts.SyntaxKind.ExclamationEqualsToken,
  '===': ts.SyntaxKind.EqualsEqualsEqualsToken, '!==': ts.SyntaxKind.ExclamationEqualsEqualsToken,
  '<': ts.SyntaxKind.LessThanToken, '<=': ts.SyntaxKind.LessThanEqualsToken,
  '>': ts.SyntaxKind.GreaterThanToken, '>=': ts.SyntaxKind.GreaterThanEqualsToken,
  '+': ts.SyntaxKind.PlusToken, '-': ts.SyntaxKind.MinusToken, '*': ts.SyntaxKind.AsteriskToken,
  '/': ts.SyntaxKind.SlashToken, '%': ts.SyntaxKind.PercentToken, '**': ts.SyntaxKind.AsteriskAsteriskToken,
  '|': ts.SyntaxKind.BarToken, '&': ts.SyntaxKind.AmpersandToken, '^': ts.SyntaxKind.CaretToken,
  '<<': ts.SyntaxKind.LessThanLessThanToken, '>>': ts.SyntaxKind.GreaterThanGreaterThanToken,
  '>>>': ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
  instanceof: ts.SyntaxKind.InstanceOfKeyword, in: ts.SyntaxKind.InKeyword,
  '&&': ts.SyntaxKind.AmpersandAmpersandToken, '||': ts.SyntaxKind.BarBarToken, '??': ts.SyntaxKind.QuestionQuestionToken,
  '=': ts.SyntaxKind.EqualsToken, '+=': ts.SyntaxKind.PlusEqualsToken, '-=': ts.SyntaxKind.MinusEqualsToken,
  '*=': ts.SyntaxKind.AsteriskEqualsToken, '/=': ts.SyntaxKind.SlashEqualsToken, '%=': ts.SyntaxKind.PercentEqualsToken,
  '&&=': ts.SyntaxKind.AmpersandAmpersandEqualsToken, '||=': ts.SyntaxKind.BarBarEqualsToken, '??=': ts.SyntaxKind.QuestionQuestionEqualsToken,
} as const;

function compileExpression(node: Expression): ts.Expression {
  switch (node.kind) {
    case 'identifier': return factory.createIdentifier(node.name);
    case 'literal':
      if (node.value === null) return factory.createNull();
      if (typeof node.value === 'string') return stringLiteral(node.value);
      if (typeof node.value === 'number') return factory.createNumericLiteral(node.value);
      return node.value ? factory.createTrue() : factory.createFalse();
    case 'array': return factory.createArrayLiteralExpression(node.elements.map(compileExpression));
    case 'object': return factory.createObjectLiteralExpression(node.properties.map(property => property.kind === 'spread'
      ? factory.createSpreadAssignment(compileExpression(property.expression))
      // Ключ-идентификатор печатается без кавычек, как пишут руками: `{ "vat": "std" }` в коде
      // не идиоматичен, а гейт «Ответы человека в коде» ищет цитату человека `vat: 'std'`
      // в добавленных строках и не находил её из-за кавычек вокруг ключа (оракул, vat-rounding).
      : factory.createPropertyAssignment(/^[A-Za-z_$][\w$]*$/u.test(property.key) ? factory.createIdentifier(property.key) : stringLiteral(property.key), compileExpression(property.value))));
    case 'property_access':
      if (node.computed) return factory.createElementAccessExpression(compileExpression(node.object), compileExpression(node.property));
      if (node.property.kind !== 'identifier') unsupported('non-computed property access requires an identifier property');
      return factory.createPropertyAccessExpression(compileExpression(node.object), factory.createIdentifier((node.property as { kind: 'identifier'; name: string }).name));
    case 'call': return factory.createCallExpression(compileExpression(node.callee), undefined, node.arguments.map(compileExpression));
    case 'new': return factory.createNewExpression(compileExpression(node.callee), undefined, node.arguments.map(compileExpression));
    case 'await': return factory.createAwaitExpression(compileExpression(node.expression));
    case 'unary':
      if (node.operator === 'delete') return factory.createDeleteExpression(compileExpression(node.argument));
      if (node.operator === 'typeof') return factory.createTypeOfExpression(compileExpression(node.argument));
      if (node.operator === 'void') return factory.createVoidExpression(compileExpression(node.argument));
      return factory.createPrefixUnaryExpression(unaryOperators[node.operator], compileExpression(node.argument));
    case 'binary':
    case 'logical': return factory.createBinaryExpression(compileExpression(node.left), binaryOperators[node.operator], compileExpression(node.right));
    case 'assignment': return factory.createBinaryExpression(compileExpression(node.target), binaryOperators[node.operator], compileExpression(node.value));
    case 'conditional': return factory.createConditionalExpression(compileExpression(node.test), factory.createToken(ts.SyntaxKind.QuestionToken), compileExpression(node.consequent), factory.createToken(ts.SyntaxKind.ColonToken), compileExpression(node.alternate));
    case 'arrow': return factory.createArrowFunction(modifiers(false, node.async), undefined, node.params.map(compileParameter),
      node.returnType ? compileType(node.returnType) : undefined, factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
      node.body.kind === 'block' ? compileBlock(node.body) : compileExpression(node.body));
    case 'function_expression': return factory.createFunctionExpression(modifiers(false, node.async), undefined,
      node.name ? factory.createIdentifier(node.name) : undefined, undefined, node.params.map(compileParameter),
      node.returnType ? compileType(node.returnType) : undefined, compileBlock(node.body));
    case 'spread': return factory.createSpreadElement(compileExpression(node.expression));
  }
}

function compileBlock(block: Block): ts.Block {
  return factory.createBlock(block.body.map(compileStatement), true);
}

function compileStatement(node: Statement): ts.Statement {
  switch (node.kind) {
    case 'variable_declaration': return factory.createVariableStatement(modifiers(node.export),
      factory.createVariableDeclarationList([factory.createVariableDeclaration(factory.createIdentifier(node.name), undefined,
        node.type ? compileType(node.type) : undefined, node.initializer ? compileExpression(node.initializer) : undefined)],
      node.declarationKind === 'const' ? ts.NodeFlags.Const : node.declarationKind === 'let' ? ts.NodeFlags.Let : ts.NodeFlags.None));
    case 'function_declaration': return factory.createFunctionDeclaration(modifiers(node.export, node.async), undefined,
      factory.createIdentifier(node.name), undefined, node.params.map(compileParameter), node.returnType ? compileType(node.returnType) : undefined, compileBlock(node.body));
    case 'interface_declaration': return factory.createInterfaceDeclaration(modifiers(node.export), factory.createIdentifier(node.name), undefined, undefined, [
      ...node.properties.map(property => factory.createPropertySignature(
        property.readonly ? [factory.createModifier(ts.SyntaxKind.ReadonlyKeyword)] : undefined,
        factory.createIdentifier(property.name), property.optional ? factory.createToken(ts.SyntaxKind.QuestionToken) : undefined, compileType(property.type))),
      ...node.methods.map(method => factory.createMethodSignature(undefined, factory.createIdentifier(method.name),
        method.optional ? factory.createToken(ts.SyntaxKind.QuestionToken) : undefined, undefined,
        method.params.map(compileParameter), method.returnType ? compileType(method.returnType) : undefined)),
    ]);
    case 'type_alias_declaration': return factory.createTypeAliasDeclaration(modifiers(node.export), factory.createIdentifier(node.name), undefined, compileType(node.type));
    case 'return': return factory.createReturnStatement(node.argument ? compileExpression(node.argument) : undefined);
    case 'if': return factory.createIfStatement(compileExpression(node.test), compileStatement(node.consequent), node.alternate ? compileStatement(node.alternate) : undefined);
    case 'expression_statement': return factory.createExpressionStatement(compileExpression(node.expression));
    case 'throw': return factory.createThrowStatement(compileExpression(node.argument));
    case 'import': {
      const named = node.names?.length ? factory.createNamedImports(node.names.map(name => factory.createImportSpecifier(false,
        name.local && name.local !== name.imported ? factory.createIdentifier(name.imported) : undefined, factory.createIdentifier(name.local ?? name.imported)))) : undefined;
      const clause = node.defaultImport || named || node.namespaceImport ? factory.createImportClause(node.typeOnly ?? false,
        node.defaultImport ? factory.createIdentifier(node.defaultImport) : undefined,
        node.namespaceImport ? factory.createNamespaceImport(factory.createIdentifier(node.namespaceImport)) : named) : undefined;
      return factory.createImportDeclaration(undefined, clause, stringLiteral(node.source));
    }
    case 'reexport': return factory.createExportDeclaration(undefined, node.typeOnly ?? false,
      factory.createNamedExports(node.names.map(name => factory.createExportSpecifier(false,
        name.exported && name.exported !== name.imported ? factory.createIdentifier(name.imported) : undefined,
        factory.createIdentifier(name.exported ?? name.imported)))), stringLiteral(node.source));
  }
}

function printStatement(node: Statement): string {
  return printer.printNode(ts.EmitHint.Unspecified, compileStatement(node), sourceFile);
}

function printStatements(nodes: readonly Statement[]): string {
  return nodes.map(printStatement).join('\n');
}

function assertSyntax(text: string, scriptKind: ts.ScriptKind, label: string): void {
  const parsed = ts.createSourceFile(label, text, ts.ScriptTarget.Latest, true, scriptKind);
  const diagnostics = (parsed as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
  if (diagnostics.length) {
    const detail = diagnostics.slice(0, 3).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')).join('; ');
    throw new TypedPatchCompileError(`Compiled implementation IR has invalid syntax: ${detail}`);
  }
}

function scriptKind(file: string): ts.ScriptKind {
  if (/\.tsx$/iu.test(file)) return ts.ScriptKind.TSX;
  if (/\.jsx$/iu.test(file)) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/iu.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function assertDeclaration(node: Statement): void {
  if (!['variable_declaration', 'function_declaration', 'interface_declaration', 'type_alias_declaration'].includes(node.kind))
    unsupported('declaration positions accept only variable, function, interface or type alias declarations');
}

export const typedPatchBaseOperation = (op: TypedPatchOp['op']): SymbolOp['op'] => ({
  create_file_ir: 'create_file', replace_function_ir: 'replace_function_body', replace_declaration_ir: 'replace_declaration',
  insert_before_ir: 'insert_before', insert_after_ir: 'insert_after',
}[op] as SymbolOp['op']);

export function compileTypedPatch(op: TypedPatchOp): SymbolOp {
  switch (op.op) {
    case 'create_file_ir': {
      const body = printStatements(op.module.body);
      if (!body) throw new TypedPatchCompileError('Implementation IR module must contain at least one statement');
      assertSyntax(body, scriptKind(op.file), op.file);
      return { op: 'create_file', file: op.file, body };
    }
    case 'replace_function_ir': {
      const body = printStatements(op.body);
      if (!body) throw new TypedPatchCompileError('Implementation IR function body must contain at least one statement');
      assertSyntax(`function implementationIrTarget() {${body}\n}`, scriptKind(op.file), op.file);
      return { op: 'replace_function_body', file: op.file, symbol: op.symbol, targetId: op.targetId, expectedHash: op.expectedHash, body };
    }
    case 'replace_declaration_ir': {
      assertDeclaration(op.declaration);
      const declaration = printStatement(op.declaration);
      assertSyntax(declaration, scriptKind(op.file), op.file);
      return { op: 'replace_declaration', file: op.file, symbol: op.symbol, targetId: op.targetId, expectedHash: op.expectedHash, declaration };
    }
    case 'insert_before_ir':
    case 'insert_after_ir': {
      op.declarations.forEach(assertDeclaration);
      const body = printStatements(op.declarations);
      assertSyntax(body, scriptKind(op.file), op.file);
      return { op: op.op === 'insert_before_ir' ? 'insert_before' : 'insert_after', file: op.file, anchor: op.anchor, body };
    }
  }
}
