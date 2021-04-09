/**
 * This activity extracts all the data about a user contained in our db.
 */

import * as stream from "stream";
import * as t from "io-ts";

import { DeferredPromise } from "italia-ts-commons/lib/promises";

import { sequenceS, sequenceT } from "fp-ts/lib/Apply";
import { array, catOptions, flatten, rights } from "fp-ts/lib/Array";
import {
  Either,
  fromOption,
  isLeft,
  left,
  right,
  toError
} from "fp-ts/lib/Either";
import {
  fromEither,
  TaskEither,
  taskEither,
  taskEitherSeq,
  taskify,
  tryCatch
} from "fp-ts/lib/TaskEither";

import { Context } from "@azure/functions";

import { BlobService } from "azure-storage";
import { MessageContent } from "io-functions-commons/dist/generated/definitions/MessageContent";
import { NotificationChannelEnum } from "io-functions-commons/dist/generated/definitions/NotificationChannel";
import {
  MessageModel,
  RetrievedMessageWithoutContent
} from "io-functions-commons/dist/src/models/message";
import {
  MessageStatus,
  MessageStatusModel
} from "io-functions-commons/dist/src/models/message_status";
import { RetrievedNotification } from "io-functions-commons/dist/src/models/notification";
import { NotificationModel } from "io-functions-commons/dist/src/models/notification";
import {
  NotificationStatus,
  NotificationStatusModel
} from "io-functions-commons/dist/src/models/notification_status";
import {
  Profile,
  ProfileModel
} from "io-functions-commons/dist/src/models/profile";
import { readableReport } from "italia-ts-commons/lib/reporters";
import { FiscalCode, NonEmptyString } from "italia-ts-commons/lib/strings";

import { fromLeft } from "fp-ts/lib/TaskEither";
import { asyncIteratorToArray } from "io-functions-commons/dist/src/utils/async";
import { toCosmosErrorResponse } from "io-functions-commons/dist/src/utils/cosmosdb_model";
import * as yaml from "yaml";
import { getEncryptedZipStream } from "../utils/zip";
import { AllUserData, MessageContentWithId } from "../utils/userData";
import { generateStrongPassword, StrongPassword } from "../utils/random";
import { getMessageFromCosmosErrors } from "../utils/conversions";

// eslint-disable-next-line @typescript-eslint/naming-convention
export const ArchiveInfo = t.interface({
  blobName: NonEmptyString,
  password: StrongPassword
});
export type ArchiveInfo = t.TypeOf<typeof ArchiveInfo>;

// Activity input
// eslint-disable-next-line @typescript-eslint/naming-convention
export const ActivityInput = t.interface({
  fiscalCode: FiscalCode
});
export type ActivityInput = t.TypeOf<typeof ActivityInput>;

// Activity success result
// eslint-disable-next-line @typescript-eslint/naming-convention
export const ActivityResultSuccess = t.interface({
  kind: t.literal("SUCCESS"),
  value: ArchiveInfo
});
export type ActivityResultSuccess = t.TypeOf<typeof ActivityResultSuccess>;

// Activity failed because of invalid input
// eslint-disable-next-line @typescript-eslint/naming-convention
const ActivityResultInvalidInputFailure = t.interface({
  kind: t.literal("INVALID_INPUT_FAILURE"),
  reason: t.string
});
export type ActivityResultInvalidInputFailure = t.TypeOf<
  typeof ActivityResultInvalidInputFailure
>;

// Activity failed because of an error on a query
// eslint-disable-next-line @typescript-eslint/naming-convention
const ActivityResultQueryFailure = t.intersection([
  t.interface({
    kind: t.literal("QUERY_FAILURE"),
    reason: t.string
  }),
  t.partial({ query: t.string })
]);
export type ActivityResultQueryFailure = t.TypeOf<
  typeof ActivityResultQueryFailure
>;

// activity failed for user not found
// eslint-disable-next-line @typescript-eslint/naming-convention
const ActivityResultUserNotFound = t.interface({
  kind: t.literal("USER_NOT_FOUND_FAILURE")
});
type ActivityResultUserNotFound = t.TypeOf<typeof ActivityResultUserNotFound>;

// activity failed for user not found
// eslint-disable-next-line @typescript-eslint/naming-convention
const ActivityResultArchiveGenerationFailure = t.interface({
  kind: t.literal("ARCHIVE_GENERATION_FAILURE"),
  reason: t.string
});

export type ActivityResultArchiveGenerationFailure = t.TypeOf<
  typeof ActivityResultArchiveGenerationFailure
>;

// eslint-disable-next-line @typescript-eslint/naming-convention
export const ActivityResultFailure = t.taggedUnion("kind", [
  ActivityResultUserNotFound,
  ActivityResultQueryFailure,
  ActivityResultInvalidInputFailure,
  ActivityResultArchiveGenerationFailure
]);
export type ActivityResultFailure = t.TypeOf<typeof ActivityResultFailure>;

// eslint-disable-next-line @typescript-eslint/naming-convention
export const ActivityResult = t.taggedUnion("kind", [
  ActivityResultSuccess,
  ActivityResultFailure
]);
export type ActivityResult = t.TypeOf<typeof ActivityResult>;

const logPrefix = `ExtractUserDataActivity`;

/**
 * Converts a Promise<Either<L, R>> that can reject
 * into a TaskEither<Error | L, R>
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const fromPromiseEither = <L, R>(promise: Promise<Either<L, R>>) =>
  taskEither
    .of<Error | L, R>(void 0)
    .chainSecond(tryCatch(() => promise, toError))
    .chain(fromEither);

/**
 * To be used for exhaustive checks
 */
// eslint-disable-next-line prefer-arrow/prefer-arrow-functions
function assertNever(_: never): void {
  throw new Error("should not have executed this");
}

/**
 * Logs depending on failure type
 *
 * @param context the Azure functions context
 * @param failure the failure to log
 */
const logFailure = (context: Context) => (
  failure: ActivityResultFailure
): void => {
  switch (failure.kind) {
    case "INVALID_INPUT_FAILURE":
      context.log.error(
        `${logPrefix}|Error decoding input|ERROR=${failure.reason}`
      );
      break;
    case "QUERY_FAILURE":
      context.log.error(
        `${logPrefix}|Error ${failure.query} query error|ERROR=${failure.reason}`
      );
      break;
    case "ARCHIVE_GENERATION_FAILURE":
      context.log.error(
        `${logPrefix}|Error saving zip bundle|ERROR=${failure.reason}`
      );
      break;
    case "USER_NOT_FOUND_FAILURE":
      context.log.error(`${logPrefix}|Error user not found|ERROR=`);
      break;
    default:
      assertNever(failure);
  }
};

/**
 * Look for a profile from a given fiscal code
 *
 * @param fiscalCode a fiscal code identifying the user
 * @returns either a user profile, a query error or a user-not-found error
 */
export const getProfile = (
  profileModel: ProfileModel,
  fiscalCode: FiscalCode
): TaskEither<
  ActivityResultUserNotFound | ActivityResultQueryFailure,
  Profile
> =>
  profileModel
    .findLastVersionByModelId([fiscalCode])
    .foldTaskEither<
      ActivityResultUserNotFound | ActivityResultQueryFailure,
      Profile
    >(
      failure =>
        fromLeft(
          ActivityResultQueryFailure.encode({
            kind: "QUERY_FAILURE",
            reason: `${failure.kind}, ${getMessageFromCosmosErrors(failure)}`
          })
        ),
      maybeProfile =>
        fromEither<ActivityResultUserNotFound, Profile>(
          fromOption(
            ActivityResultUserNotFound.encode({
              kind: "USER_NOT_FOUND_FAILURE"
            })
          )(maybeProfile)
        )
    );
/**
 * Retrieves all contents for provided messages
 */
export const getAllMessageContents = (
  messageContentBlobService: BlobService,
  messageModel: MessageModel,
  messages: ReadonlyArray<RetrievedMessageWithoutContent>
): TaskEither<
  ActivityResultQueryFailure,
  ReadonlyArray<MessageContentWithId>
> =>
  array.sequence(taskEither)(
    messages.map(({ id: messageId }) =>
      messageModel
        .getContentFromBlob(messageContentBlobService, messageId)
        .foldTaskEither<ActivityResultQueryFailure, MessageContentWithId>(
          _ => fromEither(right({ messageId } as MessageContentWithId)),
          maybeContent =>
            fromEither(
              maybeContent.foldL(
                () => right({ messageId } as MessageContentWithId),
                (content: MessageContent) =>
                  right({
                    content,
                    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
                    messageId: messageId as NonEmptyString
                  })
              )
            )
        )
    )
  );

/**
 * Retrieves all statuses for provided messages
 */
export const getAllMessagesStatuses = (
  messageStatusModel: MessageStatusModel,
  messages: ReadonlyArray<RetrievedMessageWithoutContent>
): TaskEither<ActivityResultQueryFailure, ReadonlyArray<MessageStatus>> =>
  array.sequence(taskEither)(
    messages.map(({ id: messageId }) =>
      messageStatusModel
        .findLastVersionByModelId([messageId])
        .foldTaskEither<ActivityResultQueryFailure, MessageStatus>(
          failure =>
            fromLeft(
              ActivityResultQueryFailure.encode({
                kind: "QUERY_FAILURE",
                reason: `messageStatusModel|${
                  failure.kind
                }, ${getMessageFromCosmosErrors(failure)}`
              })
            ),
          maybeContent =>
            fromEither(
              maybeContent.foldL(
                () => right({ messageId } as MessageStatus),
                content => right(content)
              )
            )
        )
    )
  );

/**
 * Given a list of messages, get the relative notifications
 *
 * @param messages
 */
export const findNotificationsForAllMessages = (
  notificationModel: NotificationModel,
  messages: ReadonlyArray<RetrievedMessageWithoutContent>
): TaskEither<
  ActivityResultQueryFailure,
  ReadonlyArray<RetrievedNotification>
> =>
  array
    .sequence(taskEitherSeq)(
      messages.map(m => notificationModel.findNotificationForMessage(m.id))
    )

    .bimap(
      e =>
        ActivityResultQueryFailure.encode({
          kind: "QUERY_FAILURE",
          reason: `notificationModel.findNotificationForMessage| ${
            e.kind
          }, ${getMessageFromCosmosErrors(e)}`
        }),
      // There are cases in which a message has no notification and that's fine
      // We just filter "none" elements
      catOptions
    );

export const findAllNotificationStatuses = (
  notificationStatusModel: NotificationStatusModel,
  notifications: ReadonlyArray<RetrievedNotification>
): TaskEither<ActivityResultQueryFailure, ReadonlyArray<NotificationStatus>> =>
  array
    .sequence(taskEither)(
      // compose a query for every supported channel type
      notifications
        .reduce(
          (queries, { id: notificationId }) => [
            ...queries,
            ...Object.values(NotificationChannelEnum).map(channel => [
              notificationId,
              channel
            ])
          ],
          []
        )
        .map(([notificationId, channel]) =>
          notificationStatusModel
            .findOneNotificationStatusByNotificationChannel(
              notificationId,
              channel
            )
            .mapLeft(e =>
              ActivityResultQueryFailure.encode({
                kind: "QUERY_FAILURE",
                reason: `notificationStatusModel.findOneNotificationStatusByNotificationChannel|${
                  e.kind
                }, ${getMessageFromCosmosErrors(e)}`
              })
            )
        )
    )
    // filter empty results (it might not exist a content for a pair notification/channel)
    .map(arrayOfMaybeNotification =>
      arrayOfMaybeNotification
        // lift Option<T>[] to T[] by filtering all nones
        .map(opt => opt.getOrElse(undefined))
        .filter(value => typeof value !== "undefined")
    );

/**
 * Perform all the queries to extract all data for a given user
 *
 * @param fiscalCode user identifier
 * @returns Either a failure or a hash set with all the information regarding the user
 */
export const queryAllUserData = (
  messageModel: MessageModel,
  messageStatusModel: MessageStatusModel,
  notificationModel: NotificationModel,
  notificationStatusModel: NotificationStatusModel,
  profileModel: ProfileModel,
  messageContentBlobService: BlobService,
  fiscalCode: FiscalCode
): TaskEither<
  ActivityResultUserNotFound | ActivityResultQueryFailure,
  AllUserData
  // eslint-disable-next-line max-params
> =>
  // step 0: look for the profile
  getProfile(profileModel, fiscalCode)
    // step 1: get messages, which can be queried by only knowing the fiscal code
    .chain(profile =>
      sequenceS(taskEither)({
        // queries all messages for the user
        messages: messageModel
          .findMessages(fiscalCode)
          .chain(iterator =>
            tryCatch(
              () => asyncIteratorToArray(iterator),
              toCosmosErrorResponse
            )
          )
          .map(flatten)
          .mapLeft(_ =>
            ActivityResultQueryFailure.encode({
              kind: "QUERY_FAILURE",
              query: "findMessages",
              reason: `${_.kind}, ${getMessageFromCosmosErrors(_)}`
            })
          )
          .foldTaskEither(
            _ => fromLeft(_),
            results =>
              results.some(isLeft)
                ? fromLeft(
                    ActivityResultQueryFailure.encode({
                      kind: "QUERY_FAILURE",
                      query: "findMessages",
                      reason: "Some messages cannot be decoded"
                    })
                  )
                : fromEither(right(rights(results)))
          ),
        profile: taskEither.of(profile)
      })
    )
    // step 2: queries notifications and message contents, which need message data to be queried first
    .chain(({ profile, messages }) =>
      sequenceS(taskEither)({
        messageContents: getAllMessageContents(
          messageContentBlobService,
          messageModel,
          messages
        ),
        messageStatuses: getAllMessagesStatuses(messageStatusModel, messages),
        messages: taskEither.of(messages),
        notifications: findNotificationsForAllMessages(
          notificationModel,
          messages
        ),
        profile: taskEither.of(profile)
      })
    )
    // step 3: queries notifications statuses
    .chain(
      ({
        profile,
        messages,
        messageContents,
        messageStatuses,
        notifications
      }) =>
        sequenceS(taskEither)({
          messageContents: taskEither.of(messageContents),
          messageStatuses: taskEither.of(messageStatuses),
          messages: taskEither.of(messages),
          notificationStatuses: findAllNotificationStatuses(
            notificationStatusModel,
            notifications
          ),
          notifications: taskEither.of(notifications),
          profiles: taskEither.of([profile])
        })
    );

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const getCreateWriteStreamToBlockBlob = (blobService: BlobService) => (
  container: string,
  blob: string
) => {
  const { e1: errorOrResult, e2: resolve } = DeferredPromise<
    Either<Error, BlobService.BlobResult>
  >();
  const blobStream = blobService.createWriteStreamToBlockBlob(
    container,
    blob,
    { contentSettings: { contentType: "application/zip" } },
    (err, result) => (err ? resolve(left(err)) : resolve(right(result)))
  );
  // eslint-disable-next-line sort-keys
  return { errorOrResult, blobStream };
};

const onStreamFinished = taskify(stream.finished);

/**
 * Creates a bundle with all user data and save it to a blob on a remote storage
 *
 * @param data all extracted user data
 * @param password a password for bundle encryption
 *
 * @returns either a failure or an object with the name of the blob and the password
 */
export const saveDataToBlob = (
  blobService: BlobService,
  userDataContainerName: string,
  data: AllUserData,
  password: StrongPassword
): TaskEither<ActivityResultArchiveGenerationFailure, ArchiveInfo> => {
  const profile = data.profiles[0];
  const blobName = `${profile.fiscalCode}-${Date.now()}.zip` as NonEmptyString;
  const fileName = `${profile.fiscalCode}.yaml` as NonEmptyString;

  const zipStream = getEncryptedZipStream(password);

  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  const failure = (err: Error) =>
    ActivityResultArchiveGenerationFailure.encode({
      kind: "ARCHIVE_GENERATION_FAILURE",
      reason: err.message
    });

  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  const success = () =>
    ArchiveInfo.encode({
      blobName,
      password
    });

  const { blobStream, errorOrResult } = getCreateWriteStreamToBlockBlob(
    blobService
  )(userDataContainerName, blobName);

  zipStream.pipe(blobStream);
  zipStream.append(yaml.stringify(data), {
    name: fileName
  });

  const onZipStreamError = onStreamFinished(zipStream).mapLeft(failure);

  const onZipStreamFinalized = tryCatch(
    () => zipStream.finalize(),
    toError
  ).mapLeft(failure);

  // This task will run only when `onZipStreamFinalized` completes.
  // If `onZipStreamFinalized` does not finish, the process hangs here
  // until the function runtime timeout is reached
  const onBlobStreamWritten = fromPromiseEither(errorOrResult).bimap(
    failure,
    success
  );

  // run tasks in parallel
  return sequenceT(taskEither)(
    onZipStreamError,
    onZipStreamFinalized,
    onBlobStreamWritten
    // keep only the blob stream result
  ).map(_ => _[2]);
};

export interface IActivityHandlerInput {
  readonly messageModel: MessageModel;
  readonly messageStatusModel: MessageStatusModel;
  readonly notificationModel: NotificationModel;
  readonly notificationStatusModel: NotificationStatusModel;
  readonly profileModel: ProfileModel;
  readonly messageContentBlobService: BlobService;
  readonly userDataBlobService: BlobService;
  readonly userDataContainerName: NonEmptyString;
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-explicit-any
const cleanData = (v: any) => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { _self, _etag, _attachments, _rid, _ts, ...clean } = v;
  return clean;
};

/**
 * Factory methods that builds an activity function
 */
// eslint-disable-next-line prefer-arrow/prefer-arrow-functions
export function createExtractUserDataActivityHandler({
  messageModel,
  messageStatusModel,
  notificationModel,
  notificationStatusModel,
  profileModel,
  messageContentBlobService,
  userDataBlobService,
  userDataContainerName
}: IActivityHandlerInput): (
  context: Context,
  input: unknown
) => Promise<ActivityResult> {
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  return (context: Context, input: unknown) =>
    fromEither(
      ActivityInput.decode(input).mapLeft<ActivityResultFailure>(
        (reason: t.Errors) =>
          ActivityResultInvalidInputFailure.encode({
            kind: "INVALID_INPUT_FAILURE",
            reason: readableReport(reason)
          })
      )
    )
      .chain(({ fiscalCode }) =>
        queryAllUserData(
          messageModel,
          messageStatusModel,
          notificationModel,
          notificationStatusModel,
          profileModel,
          messageContentBlobService,
          fiscalCode
        )
      )
      .map(allUserData => {
        // remove sensitive data
        const notifications = allUserData.notifications.map(e =>
          cleanData({
            ...e,
            // eslint-disable-next-line @typescript-eslint/naming-convention
            channels: { ...e.channels, WEBHOOK: { url: undefined } }
          })
        );
        return {
          messageContents: allUserData.messageContents,
          messageStatuses: allUserData.messageStatuses.map(cleanData),
          messages: allUserData.messages.map(cleanData),
          notificationStatuses: allUserData.messageStatuses.map(cleanData),
          notifications,
          profiles: allUserData.profiles.map(cleanData)
        } as AllUserData;
      })
      .chain(allUserData =>
        saveDataToBlob(
          userDataBlobService,
          userDataContainerName,
          allUserData,
          generateStrongPassword()
        )
      )
      .bimap(
        failure => {
          logFailure(context)(failure);
          return failure;
        },
        archiveInfo =>
          ActivityResultSuccess.encode({
            kind: "SUCCESS",
            value: archiveInfo
          })
      )
      .run()
      .then(e => e.value);
}
