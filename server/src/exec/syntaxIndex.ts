import ts from 'typescript';
import type { SymbolDecl } from './symbolOps.ts';

export function isSingleDeclaration(text: string, owner?: string): boolean {
  const wrapped=owner?`class ${owner} {\n${text}\n}`:text;
  const tree=ts.createSourceFile('source.ts',wrapped,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  if ((tree as ts.SourceFile & {parseDiagnostics:readonly unknown[]}).parseDiagnostics.length || tree.statements.length!==1) return false;
  if(owner){const statement=tree.statements[0]!;return ts.isClassDeclaration(statement)&&statement.members.length===1;}
  const statement=tree.statements[0]!;
  return ts.isFunctionDeclaration(statement)||ts.isClassDeclaration(statement)||ts.isInterfaceDeclaration(statement)||ts.isTypeAliasDeclaration(statement)||ts.isEnumDeclaration(statement)||ts.isVariableStatement(statement)&&statement.declarationList.declarations.length===1;
}

/** One compiler-derived index for context, target identities and edits. Never guesses a brace. */
export function syntaxIndex(source: string): SymbolDecl[] {
  const tree = ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: SymbolDecl[] = [];
  const add = (node: ts.Node, name: string, kind: SymbolDecl['kind'], qualified = name, body?: ts.Node, owner?: ts.Node) => {
    const declaration = owner ?? node;
    const comments = (declaration as ts.Node & { jsDoc?: readonly ts.Node[] }).jsDoc;
    const start = comments?.length ? comments[0]!.getStart(tree) : declaration.getStart(tree);
    const modifiers = ts.canHaveModifiers(declaration) ? ts.getModifiers(declaration) : undefined;
    out.push({ name, qualified, kind, exported: modifiers?.some(mod => mod.kind === ts.SyntaxKind.ExportKeyword) ?? false,
      start, end: declaration.end, bodyStart: body && ts.isBlock(body) ? body.getStart(tree) + 1 :
        body && (ts.isClassDeclaration(body) || ts.isInterfaceDeclaration(body) || ts.isEnumDeclaration(body)) ? body.members.pos : null,
      bodyEnd: body && (ts.isBlock(body) || ts.isClassDeclaration(body) || ts.isInterfaceDeclaration(body) || ts.isEnumDeclaration(body)) ? body.end - 1 : null });
  };
  for (const node of tree.statements) {
    if (ts.isFunctionDeclaration(node) && node.name) add(node, node.name.text, 'function', undefined, node.body);
    else if (ts.isClassDeclaration(node) && node.name) {
      add(node, node.name.text, 'class', undefined, node);
      for (const member of node.members) {
        if (!member.name || !ts.isIdentifier(member.name)) continue;
        const qualified = `${node.name.text}.${member.name.text}`;
        if (ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) add(member, member.name.text, 'method', qualified, member.body);
        else if (ts.isPropertyDeclaration(member)) add(member, member.name.text, 'property', qualified);
      }
    } else if (ts.isInterfaceDeclaration(node)) add(node, node.name.text, 'interface', undefined, node);
    else if (ts.isTypeAliasDeclaration(node)) add(node, node.name.text, 'type');
    else if (ts.isEnumDeclaration(node)) add(node, node.name.text, 'enum', undefined, node);
    else if (ts.isVariableStatement(node)) {
      // A multi-declaration statement cannot be independently replaced without rewriting siblings.
      if (node.declarationList.declarations.length !== 1) continue;
      const declaration = node.declarationList.declarations[0]!;
      if (!ts.isIdentifier(declaration.name)) continue;
      const initializer = declaration.initializer;
      const body = initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) && ts.isBlock(initializer.body) ? initializer.body : undefined;
      add(declaration, declaration.name.text, 'variable', undefined, body, node);
    }
  }
  return out;
}
