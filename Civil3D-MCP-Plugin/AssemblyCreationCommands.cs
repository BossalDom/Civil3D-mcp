using System.Text.Json.Nodes;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using Autodesk.Civil.ApplicationServices;
using Autodesk.Civil.DatabaseServices;
using AcDbObject = Autodesk.AutoCAD.DatabaseServices.DBObject;

namespace Civil3DMcpPlugin;

/// <summary>
/// Assembly operations implemented with the documented Civil 3D 2026 API.
/// Dynamic stock-subassembly parameters are the only compatibility access.
/// </summary>
public static class AssemblyCreationCommands
{
  public static Task<object?> ListAssembliesAsync()
  {
    return CivilExecution.ReadAsync<object?>((doc, civilDoc, database, transaction) =>
    {
      var assemblies = civilDoc.AssemblyCollection
        .Select(id => CivilObjectUtils.GetRequiredObject<Assembly>(transaction, id, OpenMode.ForRead))
        .Select(assembly =>
        {
          var summary = ToAssemblySummary(assembly);
          summary["usedByCorridors"] = new List<string>();
          return summary;
        })
        .ToList();

      return new Dictionary<string, object?> { ["assemblies"] = assemblies };
    });
  }

  public static Task<object?> GetAssemblyAsync(JsonObject? parameters)
  {
    var name = PluginRuntime.GetRequiredString(parameters, "name");
    return CivilExecution.ReadAsync<object?>((doc, civilDoc, database, transaction) =>
    {
      var assembly = FindAssemblyByName(civilDoc, transaction, name, OpenMode.ForRead);
      var usedByCorridors = new List<string>();

      foreach (ObjectId corridorId in civilDoc.CorridorCollection)
      {
        var corridor = CivilObjectUtils.GetRequiredObject<Corridor>(transaction, corridorId, OpenMode.ForRead);
        foreach (Baseline baseline in corridor.Baselines)
        {
          foreach (BaselineRegion region in baseline.BaselineRegions)
          {
            if (region.AssemblyId == assembly.ObjectId && !usedByCorridors.Contains(corridor.Name))
              usedByCorridors.Add(corridor.Name);
          }
        }
      }

      return new Dictionary<string, object?>
      {
        ["name"] = assembly.Name,
        ["handle"] = CivilObjectUtils.GetHandle(assembly),
        ["subassemblyCount"] = GetSubassemblyIds(assembly).Count,
        ["style"] = GetStyleName(assembly, transaction),
        ["type"] = assembly.Type.ToString(),
        ["subassemblies"] = GetSubassemblies(assembly, transaction),
        ["usedByCorridors"] = usedByCorridors,
      };
    });
  }

  public static Task<object?> CreateAssemblyAsync(JsonObject? parameters)
  {
    var name = PluginRuntime.GetRequiredString(parameters, "name");
    var insertX = PluginRuntime.GetRequiredDouble(parameters, "insertX");
    var insertY = PluginRuntime.GetRequiredDouble(parameters, "insertY");
    var description = PluginRuntime.GetOptionalString(parameters, "description") ?? string.Empty;
    var assemblyTypeText = PluginRuntime.GetRequiredString(parameters, "assemblyType");
    if (!Enum.TryParse<AssemblyType>(assemblyTypeText, ignoreCase: true, out var assemblyType))
    {
      throw new JsonRpcDispatchException(
        "CIVIL3D.INVALID_INPUT",
        $"Invalid assemblyType '{assemblyTypeText}'. Use {string.Join(", ", Enum.GetNames<AssemblyType>())}.");
    }

    return CivilExecution.WriteAsync<object?>((doc, civilDoc, database, transaction) =>
    {
      var assemblyId = civilDoc.AssemblyCollection.Add(name, assemblyType, new Point3d(insertX, insertY, 0));
      var assembly = CivilObjectUtils.GetRequiredObject<Assembly>(transaction, assemblyId, OpenMode.ForWrite);
      assembly.Description = description;

      return new Dictionary<string, object?>
      {
        ["name"] = assembly.Name,
        ["handle"] = CivilObjectUtils.GetHandle(assembly),
        ["insertX"] = insertX,
        ["insertY"] = insertY,
        ["assemblyType"] = assembly.Type.ToString(),
        ["created"] = true,
      };
    });
  }

  public static Task<object?> CreateSubassemblyAsync(JsonObject? parameters)
  {
    var assemblyName = PluginRuntime.GetRequiredString(parameters, "assemblyName");
    var subassemblyType = PluginRuntime.GetRequiredString(parameters, "subassemblyType");
    var side = PluginRuntime.GetRequiredString(parameters, "side");
    if (!new[] { "Left", "Right", "Both" }.Contains(side, StringComparer.OrdinalIgnoreCase))
      throw new JsonRpcDispatchException("CIVIL3D.INVALID_INPUT", "side must be Left, Right, or Both.");

    var subParams = ReadParameters(parameters?["parameters"] as JsonObject);
    return CivilExecution.WriteAsync<object?>((doc, civilDoc, database, transaction) =>
    {
      var assembly = FindAssemblyByName(civilDoc, transaction, assemblyName, OpenMode.ForWrite);
      var requestedSides = side.Equals("Both", StringComparison.OrdinalIgnoreCase)
        ? new[] { "Left", "Right" }
        : new[] { side };
      var created = new List<Dictionary<string, object?>>();

      foreach (var requestedSide in requestedSides)
      {
        var subassemblyName = $"{subassemblyType}-{requestedSide}-{Guid.NewGuid():N}";
        var subassemblyId = civilDoc.SubassemblyCollection.ImportStockSubassembly(
          subassemblyName,
          subassemblyType,
          assembly.Location);
        assembly.AddSubassembly(subassemblyId);

        var subassembly = CivilObjectUtils.GetRequiredObject<AcDbObject>(transaction, subassemblyId, OpenMode.ForWrite);
        if (!Civil3DCompatibility.TrySetProperty(subassembly, "Side", requestedSide))
        {
          throw new JsonRpcDispatchException(
            "CIVIL3D.API_ERROR",
            $"Stock subassembly '{subassemblyType}' does not expose a writable Side parameter. No implicit side was assumed.");
        }
        ApplySubassemblyParameters(subassembly, subParams);

        created.Add(new Dictionary<string, object?>
        {
          ["name"] = CivilObjectUtils.GetName(subassembly) ?? subassemblyName,
          ["handle"] = CivilObjectUtils.GetHandle(subassembly),
          ["side"] = requestedSide,
        });
      }

      return new Dictionary<string, object?>
      {
        ["assemblyName"] = assemblyName,
        ["subassemblyType"] = subassemblyType,
        ["subassemblies"] = created,
        ["added"] = true,
      };
    });
  }

  public static Task<object?> EditAssemblyAsync(JsonObject? parameters)
  {
    var assemblyName = PluginRuntime.GetRequiredString(parameters, "assemblyName");
    var subassemblyName = PluginRuntime.GetOptionalString(parameters, "subassemblyName");
    var deleteSubassembly = PluginRuntime.GetOptionalBool(parameters, "delete") ?? false;
    var editParameters = ReadParameters(parameters?["parameters"] as JsonObject);

    return CivilExecution.WriteAsync<object?>((doc, civilDoc, database, transaction) =>
    {
      var openMode = deleteSubassembly || editParameters.Count > 0 ? OpenMode.ForWrite : OpenMode.ForRead;
      var assembly = FindAssemblyByName(civilDoc, transaction, assemblyName, openMode);
      var subassemblyIds = GetSubassemblyIds(assembly);

      if (string.IsNullOrWhiteSpace(subassemblyName))
      {
        var subassemblies = subassemblyIds
          .Select(id => CivilObjectUtils.GetRequiredObject<AcDbObject>(transaction, id, OpenMode.ForRead))
          .Select(ToSubassemblySummary)
          .ToList();
        return new Dictionary<string, object?>
        {
          ["assemblyName"] = assemblyName,
          ["subassemblyCount"] = subassemblies.Count,
          ["subassemblies"] = subassemblies,
        };
      }

      var targetId = subassemblyIds.FirstOrDefault(id =>
      {
        var candidate = CivilObjectUtils.GetRequiredObject<AcDbObject>(transaction, id, OpenMode.ForRead);
        return string.Equals(CivilObjectUtils.GetName(candidate), subassemblyName, StringComparison.OrdinalIgnoreCase);
      });
      if (targetId.IsNull)
        throw new JsonRpcDispatchException("CIVIL3D.OBJECT_NOT_FOUND", $"Subassembly '{subassemblyName}' not found in assembly '{assemblyName}'.");

      var target = CivilObjectUtils.GetRequiredObject<AcDbObject>(transaction, targetId, OpenMode.ForWrite);
      if (deleteSubassembly)
      {
        target.Erase();
        return new Dictionary<string, object?>
        {
          ["assemblyName"] = assemblyName,
          ["subassemblyName"] = subassemblyName,
          ["deleted"] = true,
        };
      }

      var updated = ApplySubassemblyParameters(target, editParameters);
      if (editParameters.Count > 0 && updated.Count != editParameters.Count)
      {
        var missing = editParameters.Keys.Except(updated, StringComparer.OrdinalIgnoreCase);
        throw new JsonRpcDispatchException(
          "CIVIL3D.INVALID_INPUT",
          $"Subassembly parameters were not writable: {string.Join(", ", missing)}. The transaction was not committed.");
      }

      return new Dictionary<string, object?>
      {
        ["assemblyName"] = assemblyName,
        ["subassemblyName"] = subassemblyName,
        ["updatedParameters"] = updated,
        ["updated"] = updated.Count > 0,
      };
    });
  }

  private static Dictionary<string, object?> ReadParameters(JsonObject? values)
  {
    var result = new Dictionary<string, object?>(StringComparer.OrdinalIgnoreCase);
    if (values == null) return result;
    foreach (var pair in values)
      result[pair.Key] = pair.Value?.GetValue<object>();
    return result;
  }

  private static Assembly FindAssemblyByName(
    CivilDocument civilDocument,
    Transaction transaction,
    string name,
    OpenMode openMode)
  {
    foreach (ObjectId id in civilDocument.AssemblyCollection)
    {
      var assembly = CivilObjectUtils.GetRequiredObject<Assembly>(transaction, id, openMode);
      if (string.Equals(assembly.Name, name, StringComparison.OrdinalIgnoreCase))
        return assembly;
    }
    throw new JsonRpcDispatchException("CIVIL3D.OBJECT_NOT_FOUND", $"Assembly '{name}' was not found in the drawing.");
  }

  private static List<ObjectId> GetSubassemblyIds(Assembly assembly)
  {
    return assembly.Groups
      .SelectMany(group => group.GetSubassemblyIds().Cast<ObjectId>())
      .Where(id => !id.IsNull)
      .Distinct()
      .ToList();
  }

  private static List<string> ApplySubassemblyParameters(AcDbObject subassembly, IReadOnlyDictionary<string, object?> parameters)
  {
    var updated = new List<string>();
    foreach (var pair in parameters)
    {
      if (Civil3DCompatibility.TrySetProperty(subassembly, pair.Key, pair.Value))
        updated.Add(pair.Key);
    }
    return updated;
  }

  private static string? GetStyleName(Assembly assembly, Transaction transaction)
  {
    if (assembly.StyleId.IsNull) return null;
    return CivilObjectUtils.GetName(transaction.GetObject(assembly.StyleId, OpenMode.ForRead));
  }

  private static List<Dictionary<string, object?>> GetSubassemblies(Assembly assembly, Transaction transaction)
  {
    return GetSubassemblyIds(assembly)
      .Select(id => CivilObjectUtils.GetRequiredObject<AcDbObject>(transaction, id, OpenMode.ForRead))
      .Select(ToSubassemblySummary)
      .ToList();
  }

  private static Dictionary<string, object?> ToSubassemblySummary(AcDbObject subassembly)
  {
    return new Dictionary<string, object?>
    {
      ["name"] = CivilObjectUtils.GetName(subassembly) ?? subassembly.Handle.ToString(),
      ["handle"] = CivilObjectUtils.GetHandle(subassembly),
      ["type"] = subassembly.GetType().Name,
      ["parameters"] = Civil3DCompatibility.GetReadableScalarProperties(subassembly),
    };
  }

  private static Dictionary<string, object?> ToAssemblySummary(Assembly assembly)
  {
    return new Dictionary<string, object?>
    {
      ["name"] = assembly.Name,
      ["handle"] = CivilObjectUtils.GetHandle(assembly),
      ["subassemblyCount"] = GetSubassemblyIds(assembly).Count,
      ["type"] = assembly.Type.ToString(),
    };
  }
}
