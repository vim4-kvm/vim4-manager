package i18n

import "strings"

// Legacy helper messages: keep exact Chinese strings for board upgrades.
// New helpers may emit the English catalog text; unknown output is preserved.
var legacyHelperKeys = map[string]string{
	"输入刷新率尚未验证，保持黑屏":                                "output.helperUnverifiedRefresh",
	"显示器没有与输入刷新率匹配的已验证模式":                           "output.helperNoMatchingMode",
	"请检查 HDMI 输入线或信号源设置。":                           "output.helperCheckSource",
	"未验证的运行模块，保留独立 KVM 采集":                          "output.helperUnverifiedModule",
	"无法唯一识别 VFM 采集端点":                               "output.helperCaptureEndpoint",
	"隔行输入尚未验证":                                      "output.helperInterlaced",
	"显示器没有已验证的逐行模式":                                 "output.helperNoProgressiveMode",
	"显示器 EDID 无效":                                   "output.helperInvalidEDID",
	"无法读取 HDMI OUT HPD":                             "output.helperHpdRead",
	"Dolby Vision 信号无法透传，请在信号源中选择 HDR10、HLG 或 SDR。": "output.helperDolbyVision",
	"此 HDR 输入格式无法识别，请在信号源中选择 HDR10、HLG 或 SDR。":      "output.helperUnknownHDR",
	"HDR 映射尚未就绪，请在更新中切换到支持 HDR 映射的内核，或将信号源设为 SDR。":  "output.helperMappingUnavailable",
	"显示器不支持当前输入所需的颜色格式":                             "output.helperColorUnsupported",
	"透传控制服务未响应":                                     "output.helperServiceUnresponsive",
	"当前内核或 VFM 路由未通过透传资格验证":                         "output.helperUnverifiedRoute",
	"音频控制服务未安装，未更改当前设置":                             "output.helperAudioMissing",
	"等待透传控制超时":                                      "output.helperTimedOut",
	"无法读取持久 OSD blank 状态":                           "output.helperOsdRead",
	"OSD 恢复状态无效":                                    "output.helperOsdRecovery",
	"EDID 长度、扩展块或校验和无效":                             "edid.invalidBytes",
	"EDID 预设清单无效":                                   "edid.invalidManifest",
	"EDID 预设字段无效":                                   "edid.invalidFields",
	"EDID 预设标识无效或重复":                                "edid.duplicateId",
	"EDID 清单缺少 VIM4-4K60 默认预设":                      "edid.defaultMissing",
	"JetKVM 配置不是 JSON 对象":                           "edid.invalidJetKVM",
	"未知 EDID 预设":                                    "edid.unknownPreset",
	"恢复原配置失败，请检查 HDMI 和 JetKVM 服务":                  "edid.recoveryFailed",
	"EDID 切换失败；已恢复原配置":                              "edid.restored",
	"EDID 切换失败；恢复原配置失败，请检查 HDMI 和 JetKVM 服务":        "edid.notRestored",
	"透传状态读取失败":                                      "output.helperRead",
	"透传设置失败":                                        "output.helperSet",
	"操作已取消":                                         "common.cancelled",
	"请选择镜像列表中的文件":                                   "media.chooseImage",
	"镜像必须是至少 512 字节、无硬链接的普通文件":                      "media.invalidImage",
	"数据盘正在管理面板中编辑，请稍后再挂载":                           "media.editing",
	"镜像正在文件传输中，请稍后再挂载":                              "media.transferring",
	"数据盘已改变，请重试":                                    "media.changed",
	"镜像已挂载，请先在被控机安全弹出，再在管理面板卸载":                     "media.alreadyMounted",
	"镜像目录条目过多，请先整理目录":                               "media.tooManyEntries",
	"数据盘名称无效":                                       "media.invalidName",
	"数据盘正在使用":                                       "media.busy",
	"数据盘已挂载到被控电脑，请先安全弹出":                            "media.ejectRequired",
	"内核清单必须由 root 管理且不可被其他用户写入":                     "kernel.manifestPermissions",
	"需要已安装的 5.15 和 7.x 内核清单":                        "kernel.manifestMissing",
	"内核清单标识无效":                                      "kernel.manifestId",
	"启动标签无效":                                        "kernel.bootLabel",
	"内核文件校验清单为空":                                    "kernel.emptyChecksums",
	"启动标签重复":                                        "kernel.duplicateLabels",
	"启动配置字段重复":                                      "kernel.duplicateFields",
	"启动配置需要唯一的默认项":                                  "kernel.defaultMissing",
	"已安装内核缺少启动项":                                    "kernel.bootEntryMissing",
	"启动参数已改变，请先重新验证内核部署":                            "kernel.bootArgsChanged",
	"内核文件路径无效":                                      "kernel.invalidPath",
	"内核文件不在启动或模块目录":                                 "kernel.outsideBoot",
	"内核文件缺失或校验值无效":                                  "kernel.invalidChecksum",
	"未知内核":                                          "kernel.unknown",
	"无法修改默认启动项":                                     "kernel.defaultFailed",
}

func helperPrefix(message string) (Message, bool) {
	for _, prefix := range []string{"内核文件校验失败：", "Kernel checksum verification failed: "} {
		if name, ok := strings.CutPrefix(message, prefix); ok {
			return Message{Key: "kernel.checksumFailed", Args: map[string]any{"name": name}}, true
		}
	}
	return Message{}, false
}
