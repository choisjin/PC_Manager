namespace PcManager.Server.Contracts;

/// <summary>채팅방 구성원</summary>
public record ChatMemberView(string UserId, DateTime JoinedAt);

/// <summary>채팅방. Kind: "direct"(1:1) | "group"</summary>
/// <param name="Name">그룹 방 이름. 1:1은 null (화면에서 상대 이름을 쓴다)</param>
/// <param name="OwnerId">그룹 방장 (강퇴 가능). 1:1은 null</param>
/// <param name="Reads">사용자별 마지막으로 읽은 메시지 번호 (안 읽음·읽음 표시용)</param>
/// <param name="LastMessage">목록 미리보기용 마지막 메시지</param>
/// <param name="Unread">요청한 사용자가 아직 안 읽은 메시지 수</param>
public record ChatRoomView(
    string Id,
    string Kind,
    string? Name,
    string? OwnerId,
    IReadOnlyList<ChatMemberView> Members,
    DateTime CreatedAt,
    IReadOnlyDictionary<string, long> Reads,
    ChatRoomMessageView? LastMessage,
    int Unread);

/// <param name="UserId">보낸 사람. 시스템 안내(초대·강퇴 등)는 null</param>
public record ChatRoomMessageView(long Id, string RoomId, string? UserId, string Text, DateTime At, IReadOnlyList<string>? Mentions = null);

public record CreateGroupChatRequest(string? Name, IReadOnlyList<string>? MemberIds);

public record OpenDirectChatRequest(string? UserId);

public record InviteChatRequest(IReadOnlyList<string>? UserIds);

public record RenameChatRequest(string? Name);

public record SendChatRequest(string? Text, IReadOnlyList<string>? Mentions);

public record ReadChatRequest(long MessageId);
