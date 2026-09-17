#ifndef __FONT_H
#define __FONT_H       

#include "stm32f4xx.h"

/** @defgroup FONTS_Exported_Types
  * @{
  */ 
typedef struct _tFont
{    
  const uint8_t *table;
  uint16_t Width;
  uint16_t Height;
  
} sFONT;

extern sFONT Font8x16;
extern sFONT Font16x24;
extern sFONT Font24x32;
extern sFONT Font16x32;
extern sFONT Font24x48;

/**
 * @brief 自定义点阵字模描述结构体
 */
typedef struct {
    const uint8_t *table;     // 字模数据表指针
    uint8_t width;            // 字符宽度（像素）
    uint8_t height;           // 字符高度（像素）
    uint8_t bytes_per_row;    // 每行占用的字节数
    uint8_t is_yin_code;      // 是否为阴码（1：阴码，0：阳码）
    uint8_t scan_direction;   // 扫描方向：0=逐行顺向，1=逐行逆向
} FontBitmap_t;

extern FontBitmap_t SongTi_16x16;
extern FontBitmap_t SongTi_32x32;

#endif /* __FONT_H */
