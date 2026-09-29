namespace PcManager.Server.Contracts;

/// <param name="Favorites">agentId → 즐겨찾기 폴더 경로 목록</param>
public record PcFavoritesView(IReadOnlyDictionary<string, IReadOnlyList<string>> Favorites);
