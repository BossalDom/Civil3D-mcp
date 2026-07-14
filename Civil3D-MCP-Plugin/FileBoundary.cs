using System.Text;

namespace Civil3DMcpPlugin;

/// <summary>
/// Authoritative filesystem boundary for caller-supplied import and export paths.
/// Paths are canonicalized, restricted to configured roots, and checked against
/// a command-specific extension allowlist before Civil 3D or System.IO sees them.
/// </summary>
internal static class FileBoundary
{
  private const string SharedRootsVariable = "CIVIL3D_FILE_ROOTS";
  private const string ImportRootsVariable = "CIVIL3D_IMPORT_ROOTS";
  private const string ExportRootsVariable = "CIVIL3D_EXPORT_ROOTS";

  private static readonly Lazy<string[]> ImportRoots = new(() => LoadRoots(ImportRootsVariable));
  private static readonly Lazy<string[]> ExportRoots = new(() => LoadRoots(ExportRootsVariable));

  public static string ResolveImportPath(string rawPath, params string[] allowedExtensions)
  {
    var path = ResolvePath(rawPath, ImportRoots.Value, "import", allowedExtensions);
    if (!File.Exists(path))
    {
      throw new JsonRpcDispatchException("CIVIL3D.OBJECT_NOT_FOUND", $"Import file was not found: {path}");
    }

    return path;
  }

  public static string ResolveExportPath(
    string rawPath,
    bool overwrite,
    params string[] allowedExtensions)
  {
    var path = ResolvePath(rawPath, ExportRoots.Value, "export", allowedExtensions);
    if (File.Exists(path) && !overwrite)
    {
      throw new JsonRpcDispatchException(
        "CIVIL3D.CONFLICT",
        $"Output file already exists: {path}. Set overwrite=true to replace it explicitly.");
    }

    return path;
  }

  public static string WriteAllTextAtomic(
    string rawPath,
    string content,
    Encoding encoding,
    bool overwrite,
    params string[] allowedExtensions)
  {
    var path = ResolveExportPath(rawPath, overwrite, allowedExtensions);
    var directory = Path.GetDirectoryName(path)
      ?? throw new JsonRpcDispatchException("CIVIL3D.INVALID_INPUT", "Output path must include a directory.");
    Directory.CreateDirectory(directory);

    var tempPath = Path.Combine(directory, $".{Path.GetFileName(path)}.{Guid.NewGuid():N}.tmp");
    try
    {
      File.WriteAllText(tempPath, content, encoding);
      File.Move(tempPath, path, overwrite);
      return path;
    }
    catch (IOException) when (!overwrite && File.Exists(path))
    {
      throw new JsonRpcDispatchException(
        "CIVIL3D.CONFLICT",
        $"Output file already exists: {path}. Set overwrite=true to replace it explicitly.");
    }
    catch (JsonRpcDispatchException)
    {
      throw;
    }
    catch (Exception exception)
    {
      throw new JsonRpcDispatchException(
        "CIVIL3D.FILE_IO_ERROR",
        $"Unable to write output file '{path}': {exception.Message}");
    }
    finally
    {
      try
      {
        if (File.Exists(tempPath))
        {
          File.Delete(tempPath);
        }
      }
      catch
      {
        // Preserve the original operation result. Stale temp files use a
        // hidden, collision-resistant name and can be removed later.
      }
    }
  }

  private static string ResolvePath(
    string rawPath,
    IReadOnlyCollection<string> roots,
    string operation,
    IReadOnlyCollection<string> allowedExtensions)
  {
    if (string.IsNullOrWhiteSpace(rawPath))
    {
      throw new JsonRpcDispatchException("CIVIL3D.INVALID_INPUT", $"A non-empty {operation} path is required.");
    }

    if (!Path.IsPathFullyQualified(rawPath))
    {
      throw new JsonRpcDispatchException(
        "CIVIL3D.INVALID_INPUT",
        $"The {operation} path must be absolute: {rawPath}");
    }

    string canonicalPath;
    try
    {
      canonicalPath = Path.GetFullPath(rawPath);
    }
    catch (Exception exception) when (exception is ArgumentException or NotSupportedException or PathTooLongException)
    {
      throw new JsonRpcDispatchException("CIVIL3D.INVALID_INPUT", $"Invalid {operation} path: {exception.Message}");
    }

    var matchedRoot = roots.FirstOrDefault(root => IsWithinRoot(canonicalPath, root));
    if (matchedRoot == null)
    {
      throw new JsonRpcDispatchException(
        "CIVIL3D.PATH_NOT_ALLOWED",
        $"The {operation} path is outside the configured roots: {canonicalPath}");
    }

    RejectReparsePointTraversal(canonicalPath, matchedRoot);

    var allowed = allowedExtensions
      .Select(NormalizeExtension)
      .ToHashSet(StringComparer.OrdinalIgnoreCase);
    var extension = Path.GetExtension(canonicalPath);
    if (allowed.Count > 0 && !allowed.Contains(extension))
    {
      throw new JsonRpcDispatchException(
        "CIVIL3D.FILE_TYPE_NOT_ALLOWED",
        $"Extension '{extension}' is not allowed for this operation. Allowed extensions: {string.Join(", ", allowed.Order())}.");
    }

    return canonicalPath;
  }

  private static string[] LoadRoots(string operationVariable)
  {
    var configured = Environment.GetEnvironmentVariable(operationVariable);
    if (string.IsNullOrWhiteSpace(configured))
    {
      configured = Environment.GetEnvironmentVariable(SharedRootsVariable);
    }

    var roots = SplitRoots(configured).ToList();
    if (roots.Count == 0)
    {
      var documents = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
      if (!string.IsNullOrWhiteSpace(documents))
      {
        roots.Add(documents);
      }
    }

    return roots
      .Select(Path.GetFullPath)
      .Distinct(StringComparer.OrdinalIgnoreCase)
      .ToArray();
  }

  private static IEnumerable<string> SplitRoots(string? configured)
  {
    if (string.IsNullOrWhiteSpace(configured))
    {
      yield break;
    }

    foreach (var root in configured.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
    {
      if (!Path.IsPathFullyQualified(root))
      {
        throw new JsonRpcDispatchException(
          "CIVIL3D.INVALID_CONFIGURATION",
          $"Configured filesystem root must be absolute: {root}");
      }

      yield return root;
    }
  }

  private static bool IsWithinRoot(string path, string root)
  {
    var relative = Path.GetRelativePath(root, path);
    return !Path.IsPathRooted(relative)
      && !string.Equals(relative, "..", StringComparison.Ordinal)
      && !relative.StartsWith($"..{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
      && !relative.StartsWith($"..{Path.AltDirectorySeparatorChar}", StringComparison.Ordinal);
  }

  private static void RejectReparsePointTraversal(string path, string root)
  {
    var relative = Path.GetRelativePath(root, path);
    if (relative == ".")
    {
      return;
    }

    var current = root;
    foreach (var segment in relative.Split(
      [Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar],
      StringSplitOptions.RemoveEmptyEntries))
    {
      current = Path.Combine(current, segment);
      if (!Directory.Exists(current) && !File.Exists(current))
      {
        break;
      }

      try
      {
        if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
        {
          throw new JsonRpcDispatchException(
            "CIVIL3D.PATH_NOT_ALLOWED",
            $"Filesystem links and junctions are not allowed in caller-supplied paths: {current}");
        }
      }
      catch (JsonRpcDispatchException)
      {
        throw;
      }
      catch (Exception exception)
      {
        throw new JsonRpcDispatchException(
          "CIVIL3D.FILE_IO_ERROR",
          $"Unable to validate filesystem path '{current}': {exception.Message}");
      }
    }
  }

  private static string NormalizeExtension(string extension) =>
    extension.StartsWith('.') ? extension : $".{extension}";
}
