# مراجعة التنفيذ والمرجع

## ما كان صحيحاً

- التحديث الشرطي للكميات، transaction واحدة لكل الحجز، الترتيب الرقمي، وقيود PostgreSQL.
- قفل سجل الحجز عند الإلغاء لمنع إعادة الكميات مرتين.
- `int64` كـ string، تطابق RPC names، وفصل ملكية المخزون عن المنتجات والأسعار.
- Main API موجود فعلياً في `../e-commerce`؛ حافظنا على authentication وDTOs والملكية ونسخ الأسعار، وعلى compare-and-swap الموجود لتحديث حالة Order.

## المرجع الذي تمت قراءته

الفرع [feature/inventory-grpc-service](https://github.com/Ghaithehasan/scalable-ecommerce-backend/tree/feature/inventory-grpc-service)، عند commit `c321a843d6939460f611bde0f64d689bfff6389c`.
تم تنزيل نسخة قراءة داخل `.tmp/teammate-reference`، دون merge أو تعديل ذلك الفرع.

قُرئت ملفات:

- `inventory-service/src/inventory/inventory.service.ts` كاملاً.
- `proto/inventory/v1/inventory.proto` كاملاً.
- `src/inventory/inventory.client.ts` و`inventory.errors.ts` كاملين.
- الأجزاء الخاصة بإنشاء الطلب والحجز والتعويض من `src/orders/orders.service.ts`.
- مقتطفات إعداد وتنفيذ اختبارات `inventory-service/test/race.e2e-spec.ts` و`deadline.e2e-spec.ts`.

أخذنا الأفكار: tombstone دائم، batch read، deadlines واضحة، اختبار النتيجة الغامضة بعد timeout، واختبارات التنافس.
لم ننسخ البروتو المختلف عن عقد الفريق أو نغيّر أسماء الحقول القديمة.

ثغرات المرجع التي عولجت في الحل:

- الإلغاء يقرأ حالة الحجز بدون قفل، مما يسمح بإعادة الكمية مرتين.
- إعادة الحجز بنفس ID لا تقارن العناصر الأصلية.
- تسجيل الحجز بعد تعديل الكميات يصعّب تنسيق الإلغاء المتزامن؛ الحل الحالي يسجل الهوية أولاً ويستخدم uniqueness + row lock في العمليتين.
- التقاط unique violation داخل transaction PostgreSQL لا يعيد transaction من حالتها aborted؛ نستخدم `ON CONFLICT` بدلاً من ابتلاع الخطأ.
- التعويض في المرجع يسجل فشله في logs فقط؛ هنا توجد عمليات دائمة وإعادة محاولة واسترداد بعد restart.
- ضمان ID ثابت داخل طلب واحد لا يمنع تكرار طلبات HTTP؛ أضفنا مفتاحاً اختيارياً مرتبطاً بالمستخدم ونسخة العناصر.

## الإصلاحات المحلية

نتائج `UPDATE` في TypeORM PostgreSQL هي `[rows, affected]` وليست rows وحدها. أُصلح فحص reserve وrelease.
أضيف التحقق من GetStock والمدخلات الناقصة/null وحدود int64/int32 والمنتجات المكررة بعد التطبيع.
أضيفت حالة `CANCELLED` بمigration جديدة مع down يحولها إلى `RELEASED` دون حذف tombstones.
فصلت أنواع العقد عن service، وصارت الأخطاء والسجلات متناسقة.

أثناء تشغيل Main المبني، كشف اختبار النظام خللاً في Swagger/TypeScript 6 عند وجود Unicode بمسار Windows: استيرادات metadata تشير إلى مصدر مطلق غير موجود وقت التشغيل.
`scripts/swagger-plugin.cjs` يحتفظ بالمحول الرسمي ويصلح استيراداته المحلية المولدة إلى مسارات نسبية قابلة للنقل. اختبار النظام يبني Swagger schemas من ملفات `dist` فعلياً.
أُكملت هوية المستخدم المفقودة في fixture اختبارات Users الحالية دون تعديل منطق authentication في التطبيق.

## migrations والعمليات القديمة

- Inventory: `1794268800001-AddCancellationState`، بعد migration إنشاء الجداول الموجودة.
- Main: `1794268800000-AddInventoryOrderOperations` تضيف reservation UUID nullable للطلبات وجدول عمليات وتعويض دائم.
- migration Main لا ترجع للخلف إذا بقيت عمليات معلقة أو عمليات مكتملة مرتبطة بطلبات؛ حلّ ارتباطات التشغيل وأرشفتها إدارياً قبل rollback، دون فقد سجلات الحجز.
- سجلات Order القديمة لا تُزوّد بحجوزات مصطنعة، وتبقى علاقة Inventory فيها null.

## حدود الضمان

لا توجد transaction واحدة بين Main DB وInventory DB. توجد معاملات محلية وربط بالهوية وتعويض دائم.
يعيد العامل العمليات العالقة عند عودة الخدمات، ولا نضمن استعادة فورية أثناء انقطاع دائم.
مهلة RPC توقف انتظار العميل فقط؛ يمكن للطلب أن ينفذ على السيرفر لاحقاً، وتمنع tombstone الخصم بعد قرار الإلغاء.
اجعل `INVENTORY_OPERATION_TIMEOUT_MS` أكبر من ميزانية gRPC ومعاملة حفظ الطلب؛ الاسترداد يفضل إلغاء محاولة متأخرة على إنشاء طلب بدون حجز صالح.
بعد غموض نتيجة COMMIT، حالة العملية الدائمة هي المرجع: `COMPLETED` لا تُعوَّض بشكل أعمى.
يبقى تزويد المخزون وإعادة تعبئته وإدارة المرتجعات خارج RPCs الثلاث الأصلية؛ سكربت provisioning يضيف السجلات الناقصة فقط.
تحتاج tombstones وسجلات Idempotency سياسة احتفاظ مدروسة قبل أي تنظيف؛ حذفها مبكراً يُسقط ضمان منع الحجز المتأخر.
الاختبارات تستخدم PostgreSQL حقيقياً وRPCs حقيقية. أعطال الشبكة بعد commit وفشل التعويض تُحقن في حدود RPC، وفشل حفظ Order يحصل بواسطة trigger حقيقي، ولا تستخدم اختبارات المخزون repository mocks.
Docker/Azure يحتاجان تحقق تشغيل في بيئتهما؛ وجود ملفات نشر لا يعني أنه تم تشغيلها أو نشرها فعلياً.

فحص lint لـ Inventory نجح بأمره المعتاد. Windows Application Control منع تحميل ملف oxlint 1.90.0 داخل Main حتى خارج العزل؛ فُحص Main بنجاح باستخدام oxlint 1.92.0 المثبت في Inventory، من مجلد Main وبنفس إعداداته. الأمر البديل موثق في README.
