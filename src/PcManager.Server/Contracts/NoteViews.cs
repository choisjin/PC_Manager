namespace PcManager.Server.Contracts;

/// <summary>메모</summary>
/// <param name="Scope">shared(공유: 누구나 보고 고침) | personal(개인: 만든 사람만)</param>
/// <param name="OwnerId">만든 사람</param>
/// <param name="Title">목록에 보일 제목 (대시보드가 내용 첫 줄로 정함)</param>
/// <param name="Content">대시보드가 정리한 HTML (글자·줄바꿈·목록·이미지)</param>
/// <param name="UpdatedBy">마지막으로 고친 사람</param>
public record NoteView(string Id, string Scope, string OwnerId, string Title, string Content, DateTime CreatedAt, DateTime UpdatedAt, string UpdatedBy);

public record CreateNoteRequest(string? Scope);

/// <param name="BaseUpdatedAt">고치기 시작한 버전의 수정 시각. 그 사이 다른 곳에서 고쳤으면 409</param>
public record UpdateNoteRequest(string? Title, string? Content, DateTime? BaseUpdatedAt);

public record NoteImageView(string Url);
