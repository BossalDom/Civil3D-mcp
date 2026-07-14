using System.Text;
using System.Text.Json.Nodes;
using Civil3DMcpPlugin;

var testRoot = Path.Combine(Path.GetTempPath(), $"civil3d-mcp-file-boundary-{Guid.NewGuid():N}");
var allowedRoot = Path.Combine(testRoot, "allowed");
var outsideRoot = Path.Combine(testRoot, "outside");
Directory.CreateDirectory(allowedRoot);
Directory.CreateDirectory(outsideRoot);

Environment.SetEnvironmentVariable("CIVIL3D_IMPORT_ROOTS", allowedRoot);
Environment.SetEnvironmentVariable("CIVIL3D_EXPORT_ROOTS", allowedRoot);

try
{
  var nestedOutput = Path.Combine(allowedRoot, "reports", "quantities.csv");
  var canonical = FileBoundary.ResolveExportPath(nestedOutput, overwrite: false, ".csv");
  Assert(canonical == Path.GetFullPath(nestedOutput), "Allowed output was not canonicalized.");

  ExpectCode(
    "CIVIL3D.PATH_NOT_ALLOWED",
    () => FileBoundary.ResolveExportPath(Path.Combine(allowedRoot, "..", "outside", "escape.csv"), false, ".csv"));
  ExpectCode(
    "CIVIL3D.FILE_TYPE_NOT_ALLOWED",
    () => FileBoundary.ResolveExportPath(Path.Combine(allowedRoot, "report.exe"), false, ".csv"));

  var writtenPath = FileBoundary.WriteAllTextAtomic(
    nestedOutput, "first", Encoding.UTF8, overwrite: false, ".csv");
  Assert(File.ReadAllText(writtenPath, Encoding.UTF8) == "first", "Atomic write content mismatch.");
  Assert(!Directory.EnumerateFiles(Path.GetDirectoryName(writtenPath)!, ".*.tmp").Any(), "Atomic write left a temp file.");

  ExpectCode(
    "CIVIL3D.CONFLICT",
    () => FileBoundary.WriteAllTextAtomic(nestedOutput, "blocked", Encoding.UTF8, overwrite: false, ".csv"));
  FileBoundary.WriteAllTextAtomic(nestedOutput, "replacement", Encoding.UTF8, overwrite: true, ".csv");
  Assert(File.ReadAllText(writtenPath, Encoding.UTF8) == "replacement", "Explicit overwrite did not replace content.");

  var importPath = Path.Combine(allowedRoot, "terrain.dem");
  File.WriteAllText(importPath, "dem-data");
  Assert(FileBoundary.ResolveImportPath(importPath, ".dem") == Path.GetFullPath(importPath), "Allowed import was rejected.");
  ExpectCode(
    "CIVIL3D.OBJECT_NOT_FOUND",
    () => FileBoundary.ResolveImportPath(Path.Combine(allowedRoot, "missing.dem"), ".dem"));
  ExpectCode(
    "CIVIL3D.PATH_NOT_ALLOWED",
    () => FileBoundary.ResolveImportPath(Path.Combine(outsideRoot, "outside.dem"), ".dem"));

  var rpcError = JsonNode.Parse(JsonRpcProtocol.SerializeError(
    JsonValue.Create("request-1"),
    JsonRpcProtocol.NumericErrorCode("CIVIL3D.OBJECT_NOT_FOUND"),
    "CIVIL3D.OBJECT_NOT_FOUND",
    "Surface was not found"))!.AsObject();
  Assert(rpcError["jsonrpc"]!.GetValue<string>() == "2.0", "JSON-RPC version is invalid.");
  Assert(rpcError["error"]!["code"]!.GetValue<int>() == -32004, "JSON-RPC error code is not numeric.");
  Assert(rpcError["error"]!["data"]!["code"]!.GetValue<string>() == "CIVIL3D.OBJECT_NOT_FOUND", "Domain error code was not retained in error.data.code.");

  Console.WriteLine("P2 filesystem and JSON-RPC boundary checks passed.");
}
finally
{
  Directory.Delete(testRoot, recursive: true);
}

static void ExpectCode(string expectedCode, Action action)
{
  try
  {
    action();
  }
  catch (JsonRpcDispatchException exception) when (exception.Code == expectedCode)
  {
    return;
  }

  throw new InvalidOperationException($"Expected JsonRpcDispatchException code {expectedCode}.");
}

static void Assert(bool condition, string message)
{
  if (!condition)
  {
    throw new InvalidOperationException(message);
  }
}
